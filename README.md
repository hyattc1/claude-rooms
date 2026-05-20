# claude-rooms

Multiplayer Claude Code. Code with a friend in your own terminals, your Claude sessions aware of each other in real time.

## Install

```sh
/plugin marketplace add hyattc1/claude-rooms
/plugin install claude-rooms@claude-rooms
```

## Try it

```text
connor> /claude-rooms:rooms-create
        Room: kite-frog
ryan>   /claude-rooms:rooms-join kite-frog
        Joined room kite-frog as ryan. 1 teammate online: connor.
connor> /claude-rooms:rooms-status
        Room: kite-frog
        You: connor (online)
        Teammates: ryan (online)
```

That is it. From this point on, both Claudes have continuous live awareness of each other. Anything either agent does (edits, focus changes, file locks) propagates to the other in the background. Either agent can call the `read_room_state` MCP tool at any time during its own turn to pull a fresh snapshot.

## Architecture in three paragraphs

**Peer-to-peer, no server.** Every developer's Claude Code session runs its own claude-rooms MCP server, which holds a live CRDT document for the room. Sessions sync that document directly to each other over WebRTC, using y-webrtc on top of yjs. There is no relay we run, no account to make, no infrastructure to deploy. The room code is the rendezvous string used by the public signaling servers; whoever has the code is in the room.

**Shared state, not messages.** Agents do not message each other. They share a single document whose state describes every agent's current focus, branch, recent files, recent actions, and active file locks. Each agent reads from this live document via the `read_room_state` MCP tool, which is a sub-100ms in-memory query. The agent decides how to react. The PreToolUse hook on Write/Edit/MultiEdit also checks the document deterministically before any file edit, so a conflicting edit is denied with a structured reason naming the teammate who holds the file.

**Hooks for plumbing, MCP for context.** The plugin ships a small set of hooks (SessionStart, PreToolUse, PostToolUse, Stop, SessionEnd) that publish each agent's current state to the local MCP server over a Unix domain socket (or named pipe on Windows), and an MCP server that owns the y-webrtc connection and exposes two tools (`read_room_state`, `update_my_focus`) to the agent. Hooks fail open: if the MCP server is unreachable or the room is offline, every hook exits 0 silently and your local Claude Code session keeps working. claude-rooms going offline is a feature loss, not an outage.

Full design rationale (state schema, lock semantics, awareness reaping, the six lock cases, fail-open principles, out-of-scope decisions) lives in [CLAUDE.md](./CLAUDE.md).

## Slash commands

| Command | What it does |
|---|---|
| `/claude-rooms:rooms-create` | Generate a new room code and join it. Share the code with a teammate. |
| `/claude-rooms:rooms-join <code>` | Join an existing room. Warns if no teammates are detected after 3 seconds. |
| `/claude-rooms:rooms-status` | Print the current room code, you, teammates, and active file locks. |
| `/claude-rooms:rooms-leave` | Release your locks, mark offline, and clear the local room state. |

Inside the plugin, the agent also has two MCP tools: `read_room_state` (read teammate snapshot) and `update_my_focus` (publish a one-phrase status).

## Known warts

- **`@roamhq/wrtc` for the Node WebRTC backend.** y-webrtc was built for browsers, so on Node we inject `@roamhq/wrtc` (the maintained fork of the discontinued `wrtc`) via simple-peer's `peerOpts`. It works on macOS arm64, macOS x64, and Linux x64 with Node 20 LTS. Node 22+ prebuilts are not reliably available across architectures yet, so `package.json` pins `engines.node: ">=20.0.0 <23"`. Upstream context: https://github.com/WonderInventions/node-webrtc.
- **Windows support is experimental.** Install and local commands (`/rooms-create`, `/rooms-status`, etc.) work on Windows 11 with Node 20 LTS. Real cross-machine WebRTC sync from a Windows peer has not been validated for v1.
- **WSL2 cannot complete WebRTC peer-to-peer.** Every y-webrtc app hits this: the VM drops the inbound UDP needed for ICE to succeed. The plugin still installs and the local commands run, but two peers across WSL2 will not see each other. Use macOS or native Linux/Windows for the real demo.
- **Public signaling servers are community-run.** y-webrtc ships with three defaults (`wss://signaling.yjs.dev` and two heroku instances). They can rate-limit or briefly go offline. v1 does not expose an override for this; the room code remains the same regardless.
- **Mesh degrades past ~6 peers.** claude-rooms is built for pairs and small groups. Larger rooms will work technically, but the mesh topology is not optimised for them.
- **TURN fallback for symmetric NATs.** About 5% of users on aggressive symmetric NATs will fall back to public TURN, which is slower and rate-limited.

## Status and roadmap

This is v1. Out of scope for v1 (see the "What v2 might add" section in [CLAUDE.md](./CLAUDE.md)): agent-to-agent ask inboxes, persistent rooms with history, per-actor curated state projections, web dashboard, self-hosted relay option, human-facing presence display in the terminal, and a `/rooms-diagnose` bundle. Bug fixes will bump the patch version in `plugin.json`; you receive updates via `/plugin update`.

## License

MIT. See [LICENSE](./LICENSE).
