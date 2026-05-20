# claude-rooms

Multiplayer Claude Code. Two or more developers each running their own Claude Code session, sharing live state of what their agents are doing, in real time. Install the plugin, share a room code, code together.

## What this is, in one paragraph

claude-rooms is a Claude Code plugin. Each user installs it on their own machine, runs their own Claude Code session in their own terminal, and joins a shared room with a code. While in a room, every user's agent has continuous awareness of every other user's agent: what files they're touching, what they just did, what they're working on right now. The agents do not message each other like Slack DMs. They share state, like multiplayer game clients. The goal is that when Ryan asks his Claude to add an API endpoint and Connor's Claude has been refactoring auth, Connor's Claude already knows and reacts appropriately without anyone having to tell it.

## What this is NOT

- **Not agent teams.** Anthropic ships `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` for one human running multiple agents on one machine. That's a single-user productivity multiplier. claude-rooms is many humans, each with their own agent, on their own machines.
- **Not claude-code-by-agents / Agentrooms.** baryhuang's project (861 stars on GitHub) is a desktop app where one human orchestrates many Claude agents through a UI. Same one-user-many-agents model as agent teams. Not multiplayer between humans.
- **Not a relay-based hosted service.** No central server we operate. No accounts. No infrastructure for users to set up.
- **Not a shared agent.** Two humans do NOT share one Claude session. Each human has their own Claude, with their own context window. The agents are aware of each other through shared state, not by sharing a brain.
- **Not message-passing between agents.** Agents do not DM each other. The primitive is shared state, observed continuously, not events sent intermittently.

## Architecture

### The shape

Every user's Claude Code session is both a publisher and a subscriber of state. Each session publishes its own agent's current state (what file, what focus, what just happened). Each session subscribes to every other user's state. The architecture is peer-to-peer, not client-server.

### Transport: peer-to-peer via WebRTC

Use **y-webrtc** (Yjs over WebRTC) as the underlying sync layer. Rationale:

- Battle-tested. Used in production by Excalidraw, Tldraw, dozens of collaborative editors.
- Public free signaling servers exist. The plugin ships with a list of defaults. Users do not host anything.
- Data flows peer-to-peer once the connection is established. No central server sees the contents.
- Yjs gives us automatic conflict-free shared state via CRDTs. We do not implement sync logic ourselves.
- Falls back to TURN servers automatically when peer-to-peer fails. Public TURN works for v1.

The room code IS the rendezvous identifier for signaling. No accounts, no auth, no tokens. Whoever has the code is in the room.

### Distribution: standard Claude Code plugin

Repo layout follows the official plugin structure (https://code.claude.com/docs/en/plugins-reference):

```
claude-rooms/
├── .claude-plugin/
│   ├── plugin.json          # Plugin manifest
│   └── marketplace.json     # Marketplace catalog (also at repo root for /plugin marketplace add)
├── commands/                # Slash commands
│   ├── rooms-create.md
│   ├── rooms-join.md
│   ├── rooms-leave.md
│   └── rooms-status.md
├── hooks/
│   └── hooks.json           # Hook definitions
├── hooks-scripts/           # Hook implementation scripts
│   ├── session-start.js     # Pulls current room state, injects into agent context
│   ├── post-edit.js         # Broadcasts edit events to room
│   ├── pre-edit.js          # Checks file locks before edits (deterministic)
│   ├── session-end.js       # Releases locks, marks offline
│   └── shared-state.js      # The y-webrtc client used by all hooks and the MCP server
├── mcp/
│   ├── package.json
│   └── server.js            # MCP server exposing tools the agent can call
├── README.md
├── LICENSE                  # MIT
└── CLAUDE.md                # This file
```

Install via:
```
/plugin marketplace add hyattc1/claude-rooms
/plugin install claude-rooms@claude-rooms
```

### The state model

Each user broadcasts a single state document describing their agent's current condition. This document updates continuously (turn boundaries, file edits, explicit state changes). Other users subscribe to it.

State document shape (per user):
```js
{
  actor: "connor",              // user-chosen name from userConfig
  focus: "auth refactor",       // current task or focus area, set by the agent
  branch: "feat/connor",        // current git branch
  files_open: [...],            // files the agent has touched recently
  last_action: {                // what just happened
    type: "edit",
    files: ["src/auth/jwt.ts"],
    summary: "switched to refresh tokens",
    timestamp: "..."
  },
  recent_actions: [...],        // last 10 actions, for context
  blockers: [],                 // open questions or things blocking this agent
  online: true,
  last_heartbeat: "..."
}
```

State is shared via a Yjs document. Each user owns one entry keyed by their actor name. Reading other users' state is a local operation; the sync is handled by y-webrtc in the background.

### Coordination: file locks via PreToolUse hook

Soft advisory locks are not enough; the agent will forget to acquire them. The PreToolUse hook on Write|Edit|MultiEdit synchronously checks the shared state for active locks on the target files. If another user holds a lock, the hook exits 2 to block the tool call and tells the agent why. Locks are held in a Yjs shared map keyed by file path, with a 30-minute TTL refreshed on every relevant tool call.

Lock acquisition is atomic via Yjs transactions. Lock release happens in SessionEnd and explicitly via a tool.

### Context injection: SessionStart hook

The SessionStart hook pulls the current state of all teammates from the Yjs document and prints it to stdout. Claude Code injects SessionStart stdout into the session as additional context. Format:

```
## Room: <room-code>
You are in a multiplayer Claude Code room with other developers, each running their own Claude.
Other teammates currently in this room:

- ryan (online, branch feat/ryan)
  Focus: adding GET /users endpoint
  Last action: edited src/api/users.ts 2m ago
  Recent: added pagination, switched to cursor-based

- alex (online, branch feat/alex)
  Focus: writing tests for auth module
  Last action: created tests/auth.test.ts 30s ago

Tools available:
- read_room_state: fetch current state of all teammates mid-session
- update_my_focus: tell teammates what you're working on
- ask_teammate: send a question to a specific teammate's inbox
```

### MCP server

Exposes a small set of tools to the agent:

- `read_room_state` — fetch the current shared state of all teammates
- `update_my_focus(text)` — set this agent's `focus` field so teammates know what we're working on
- `add_blocker(text)` / `clear_blocker` — signal a blocker or question
- `ask_teammate(to, question)` — send a question to a specific teammate's inbox (read on their next turn)

Implementation note: the MCP server holds a persistent y-webrtc connection for the lifetime of the session, so reads are local-fast and writes propagate to peers immediately.

### Hooks summary

| Hook | When | What it does |
|---|---|---|
| SessionStart | Session begins/resumes | Connects to room, pulls teammate state, injects into context |
| PreToolUse (Write\|Edit\|MultiEdit) | Before file edit | Checks locks, acquires lock atomically, blocks if someone else holds it |
| PostToolUse (Write\|Edit\|MultiEdit) | After file edit | Updates this agent's state with the edit, refreshes lock TTL |
| Stop | End of agent turn | Updates `last_action` and rotates into `recent_actions` |
| SessionEnd | Session terminates | Releases all locks, marks this actor offline |

## Hard design decisions, with rationale

These are the choices that look arbitrary but are actually load-bearing. Do not change them without re-reading why.

**1. Peer-to-peer, not client-server.** A hosted relay would be easier to build, but requires either (a) us paying to host for everyone forever, or (b) every user setting up their own server. Both kill viral adoption. Peer-to-peer means thousands of rooms can exist simultaneously with zero operational cost to us and zero setup for users.

**2. Shared state, not messages.** DMs between agents would let things slip through the cracks (mentioned during conversation, lost in noise). Shared state means every agent always has the current picture of every teammate. The primitive is "what is each agent's state right now," not "what did each agent say."

**3. Yjs / y-webrtc, not a custom protocol.** We could invent our own sync layer. We won't. Yjs handles conflict resolution, presence, offline reconciliation, and reconnection. Years of production use. Building this ourselves would take months and have bugs.

**4. Deterministic locks via PreToolUse hook, not via MCP tool calls.** If locks are MCP tools the agent has to remember to call, the agent will forget. PreToolUse hooks fire deterministically on every relevant tool call. The agent cannot bypass them.

**5. No agent-to-agent autonomous chatter.** Agents can write to their own state. They can read others' state. They can leave a question in a teammate's inbox if a human explicitly tells them to (via `/rooms-ask`). They cannot have free-form back-and-forth conversations with each other. This prevents runaway token costs and notification fatigue.

**6. Rooms are ephemeral.** When everyone leaves, the room is gone. No persistence. No history. This is intentional for v1 — eliminates an entire class of privacy and storage concerns. Persistent rooms can be a paid feature later.

**7. The relay never sees code.** The Yjs document only contains metadata: focus, file paths, summaries, presence, locks. Never file contents. Even if WebRTC fell back to a TURN relay, the relayed data is metadata only.

**8. MIT license.** Maximally permissive. Matches Aider, Superpowers, claude-mem, claude-code-by-agents. No friction for commercial adoption.

## What v1 ships

The smallest thing that demos the wow moment:

- `/rooms-create` generates a room code and prints it
- `/rooms-join <code>` joins an existing room
- `/rooms-status` shows current room state in a clean way
- `/rooms-leave` exits the room cleanly
- SessionStart injects teammate state on every session
- PostToolUse updates this agent's state on every edit
- PreToolUse blocks edits on files locked by teammates
- MCP server exposes `read_room_state` and `update_my_focus`

That's it for v1. No agent inboxes, no chat, no persistent rooms, no web dashboard, no fancy curation. Ship the smallest thing where two friends in two terminals get the "oh shit, my Claude knows what Ryan's Claude is doing" moment.

## What v2 might add (not now)

- Inboxes / asks between agents (one human can have their agent message another's)
- Persistent rooms with history
- Per-actor state curation via Haiku (only show each agent the parts of teammate state relevant to them)
- Channels-based push for sub-second propagation (when channels exit research preview)
- Web dashboard showing live room activity
- Self-hosted relay option for teams that want private rooms

## Naming conventions

- Room codes: short, memorable, generated like Zoom links — six lowercase letters separated by a hyphen, e.g. `kite-frog`, `mint-anchor`. Easy to share verbally.
- Actor names: user-chosen at install time, kebab-case. Default to git user.name if available.
- The product is `claude-rooms`. Lowercase, hyphenated. Not "Claude Rooms" or "ClaudeRooms" anywhere in code.

## Trade-offs we accepted

- **NAT traversal sometimes fails.** WebRTC falls back to public TURN, which has rate limits. ~5% of users on aggressive symmetric NATs will have a worse experience. We accept this for v1.
- **Mesh topology degrades past 5-6 peers.** This is a tool for small teams and pairs. If you want 20-person rooms, that's a v2 problem and probably needs a different transport.
- **No offline mode.** If you're not connected to the room, you don't see teammate state. We don't try to be smart about reconciling offline edits. Reconnect, see the latest state.

## Pointers for the next agent

- Plugin docs: https://code.claude.com/docs/en/plugins-reference
- Hook docs: https://code.claude.com/docs/en/hooks
- Marketplace docs: https://code.claude.com/docs/en/plugin-marketplaces
- y-webrtc: https://github.com/yjs/y-webrtc
- Yjs: https://docs.yjs.dev
- MCP SDK: https://github.com/modelcontextprotocol/typescript-sdk (current stable is `@modelcontextprotocol/sdk` v1.29+)

## House rules

- No em dashes anywhere.
- Best engineering and UI/UX practices. Plan before changes. Verify after.
- Lowercase, hyphenated names. Functional code over clever code. Read the official docs before assuming you know something about Claude Code's plugin system; it changes.
- Commit early, push often. This is OSS, treat the git history like a public conversation.
