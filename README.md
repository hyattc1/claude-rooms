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
| `/claude-rooms:rooms-status` | Print the current room code, you, teammates, active file locks, and any territory overlaps. |
| `/claude-rooms:rooms-leave` | Release your locks, drop your territory claim, mark offline, and clear the local room state. |
| `/claude-rooms:rooms-doctor` | Print a diagnostic page (WSL2 status, ICE config, MCP socket, recommended next step). Works outside a room. |

Inside the plugin, the agent also has these MCP tools:

| Tool | What it does |
|---|---|
| `read_room_state` | Snapshot of every teammate's live state. Call it liberally. |
| `update_my_focus` | One-phrase status, so teammates see what you are currently working on. |
| `update_my_plan` | Compact summary of a multi-step plan plus done/total counts. |
| `claim_territory` | Declare which directories/files you intend to touch for the current task. |
| `release_territory` | Drop your current territory claim. |

## What v1.2 adds

Better WSL2 ergonomics and a real diagnostic. Three things:

- **WSL2 mirrored-mode documentation and detection.** Default WSL2 NAT mode blocks the inbound UDP that WebRTC needs, so cross-machine sync does not work from there. On Windows 11 22H2+, enabling WSL2 mirrored networking fixes this completely (direct peer-to-peer, no relay). The plugin detects which mode you are in and SessionStart prints a one-time hint to nudge NAT-mode users toward mirrored mode. See the "Running on WSL2" section below.
- **New `/claude-rooms:rooms-doctor` slash command.** Prints a diagnostic page (WSL status, ICE config, MCP socket discovery, recommended next step) and runs a **live ICE candidate probe** against your current config. Tells you in seconds whether your TURN configuration actually produces a `relay` candidate, instead of leaving you to guess from "the room is empty".
- **TURN and signaling userConfig overrides.** `turn_servers` and `signaling_servers` accept JSON arrays so you can plug in your own coturn instance, Cloudflare TURN with HMAC, a paid Metered.ca tier, or alternate signaling servers if you operate them. Default config is STUN-only; an honest TURN fallback for arbitrary users requires either a subscription somebody pays for or a self-hosted relay, and we will not bake credentials that pretend to work but actually do not.

> **Note on the original v1.2 plan.** An earlier 0.3.0 build shipped Open Relay's anonymous public TURN as a default fallback. Live probing showed that endpoint no longer issues relay candidates (creds widely scraped, likely rate-limited). 0.3.1 strips that default and replaces it with the live-probe diagnostic plus honest documentation. Use mirrored mode or a real TURN account.

## What v1.1 adds

Four awareness signals plus three fail-safe privacy defaults. No new external services. No new auth surface.

Awareness:
- **Git state.** `read_room_state` includes each teammate's repo, branch, short head, dirty flag, and last 5 commit subjects. `/rooms-status` lays it out per teammate. SessionStart context tags each teammate as "same branch as you, watch for conflicts", "same repo, different branch", or "different repo, probably independent work" based on a comparison with your own git state.
- **Plan-mode awareness.** When the agent is in Claude Code's plan mode, claude-rooms detects it via `permission_mode === "plan"` in hook stdin and exposes it on the actor record. The agent can call the new `update_my_plan` tool to share a one-phrase plan summary and how many checklist steps it has finished. For small one-off tasks the field stays null, so the UI does not get noisy.
- **Last user message preview.** The new `UserPromptSubmit` hook publishes the first 100 characters of each prompt so teammates can see the gist of what each user is asking. **Default OFF.** See the privacy section below for how to opt in.
- **Territory declarations.** The soft coordination layer that sits above hard file locks. The agent calls `claim_territory(['src/api/users.*', 'tests/users.*'], 'add users endpoint')` at the start of substantial tasks. Teammates see the claim and route around it at the planning stage. The PreToolUse hook also adds a soft warning to its allow-branch additionalContext when an edit lands inside a teammate's territory (the edit still proceeds because there is no lock; the warning just nudges coordination). Claims auto-expire after 2 hours. Rate-limited to one claim per 30 seconds per actor.

Privacy defaults:
- **4-word room codes** (configurable 2-6 via `room_code_length`). Drawn from the EFF Short Wordlist (1295 entries). The 4-word default yields ~2.8 trillion combinations, large enough to defeat random brute force.
- **Prompt sharing is off** by default. `last_prompt` stays null unless you set `share_prompts: true` in the plugin config. SessionStart prints a one-time hint per session reminding you the protection is on. `/rooms-status` shows a "disabled by default" line under "You".
- **Auto-redaction of likely secrets** from every free-form string the plugin writes to shared state. Anthropic / OpenAI / GitHub / AWS / Slack tokens, JWTs, PEM private keys, and URL-embedded credentials are replaced with `[redacted]` before they reach the Y.Doc, regardless of whether prompt sharing is on. A per-session counter is published in shared state and surfaced in `/rooms-status` only when nonzero. A local-only audit log at `${CLAUDE_PLUGIN_DATA}/redactions-<session_id>.log` records which patterns fired (no matched text) so you can debug false positives.

The Y.Doc schema bumps to version 2 with these fields. v1.0 clients can still join v1.1 rooms; their states show up without the new fields and v1.1 clients render them gracefully.

## Privacy and sharing

**What is shared with teammates:**

- Your file paths, branch name, commit titles, focus, plan summary, territory claims, last action.
- All of the above are visible to anyone in your room.

**What is NOT shared:**

- The contents of your files.
- Your verbatim prompts, unless you opt in via `share_prompts`. Default is OFF.
- Anything that looks like an API key, token, or private key. The scrubber redacts those before they reach shared state.

**What it means if someone joins your room (legitimately or not):**

- They can see the metadata listed above.
- They cannot read the contents of your files.
- They cannot execute code on your machine.
- They cannot impersonate you in commits or PRs.

**How to stay safe:**

- Default room codes are 4 words for a reason. Use shorter only on trusted local networks.
- Treat room codes like passwords. Do not paste them in public channels.
- The plugin redacts common credential patterns but cannot catch everything. Do not type secrets into prompts.
- If the scrubber redacts something it should not have, check `${CLAUDE_PLUGIN_DATA}/redactions-<session_id>.log` for the pattern name that matched.

**The threat model claude-rooms v1.x protects against:**

- Random brute force of room codes (defeated by the 4-word default).
- Accidental secret leakage in prompts and commits (mitigated by the scrubber, default-off prompt sharing, and the audit log).
- Strangers stumbling into your room by mistyping a code (mitigated by code length).

**The threat model claude-rooms v1.x does NOT protect against:**

- An attacker who can observe traffic on the public signaling servers (`signaling.yjs.dev` and the two Heroku instances baked into y-webrtc). The signaling protocol exchanges room topics in the clear; a sufficiently motivated attacker can enumerate currently-active topics and try them. 4-word codes raise the cost of guessing but do not hide active rooms from the relay operator.
- A determined attacker who obtains your room code by other means (over-the-shoulder, leaked Slack message, screen recording).
- Insider threats from teammates you invited.
- Network-level traffic analysis between peers.

If your work requires protection against any of those, do not use v1.x. Wait for v2 which adds end-to-end encryption and an optional self-hosted signaling server (see the Roadmap below).

claude-rooms still never sends file contents over the wire. Everything routes peer-to-peer through y-webrtc; even on TURN fallback only metadata transits the relay.

**TURN behavior (v1.2.1).** Default config is STUN-only; direct peer-to-peer must succeed. If you configure your own TURN via the `turn_servers` userConfig, the relay sees DTLS-encrypted bytes only (it cannot decrypt Y.Doc contents), but it does see your IP, your teammate's IP, and traffic timing/volume. Pick a TURN provider you trust. Power users can also override y-webrtc's signaling servers via `signaling_servers`.

## Running on WSL2

Default WSL2 networking is a NAT layer that blocks the inbound UDP that WebRTC ICE needs. Cross-machine sync **does not work** from WSL2 NAT mode without a working TURN relay (and there is no reliable free anonymous public TURN to bake in; see the note above). The supported path is to enable WSL2 mirrored networking.

Requirements: Windows 11 22H2 or higher.

Step 1: edit `%USERPROFILE%\.wslconfig` (create it if it does not exist):

```
[wsl2]
networkingMode=mirrored
firewall=true
```

Step 2: allow Hyper-V firewall inbound (one-time, admin PowerShell):

```powershell
Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow
```

Step 3: restart WSL from PowerShell or cmd:

```
wsl --shutdown
```

Reopen your terminal. Verify with `/claude-rooms:rooms-doctor`; it will report `WSL2: yes (mirrored)` on success.

If `ip -4 addr show eth0` still shows an IP in the 172.16.0.0/12 range, mirrored mode did not take effect: double-check the `.wslconfig` path, confirm your Windows build is 22H2+, and that you ran `wsl --shutdown` before reopening the terminal.

If you cannot enable mirrored mode (older Windows, corporate-managed machine), the alternative is to configure your own TURN relay via the `turn_servers` userConfig. Run `/claude-rooms:rooms-doctor` after setting it; the live ICE probe will tell you whether the relay actually produces a `relay` candidate. Options include a self-hosted [coturn](https://github.com/coturn/coturn), [Cloudflare TURN](https://developers.cloudflare.com/calls/turn/) (requires a free account and short-lived HMAC creds), or a paid [Metered.ca](https://www.metered.ca/stun-turn) / [Twilio NTS](https://www.twilio.com/docs/stun-turn) tier. None of these can be the default because none of them are free and account-less for arbitrary users.

## Roadmap (v2 candidates)

The following will be considered for v2. None are committed to v1.x.

- End-to-end encryption with a passphrase-derived shared key. Every Y.Doc update would be encrypted before it touches the signaling server or any peer.
- Self-hosted signaling server option for teams that want to keep room topics off the public infrastructure.
- Account-based access control (allowlist of public keys per room).
- Audit log of who joined a room, with timestamps.
- Persistent rooms with history.
- Entropy-based secret detection on top of the existing pattern set.

## Known warts

- **`@roamhq/wrtc` for the Node WebRTC backend.** y-webrtc was built for browsers, so on Node we inject `@roamhq/wrtc` (the maintained fork of the discontinued `wrtc`) via simple-peer's `peerOpts`. It works on macOS arm64, macOS x64, and Linux x64 with Node 20 LTS. Node 22+ prebuilts are not reliably available across architectures yet, so `package.json` pins `engines.node: ">=20.0.0 <23"`. Upstream context: https://github.com/WonderInventions/node-webrtc.
- **Windows support is experimental.** Install and local commands (`/rooms-create`, `/rooms-status`, etc.) work on Windows 11 with Node 20 LTS. Real cross-machine WebRTC sync from a Windows peer has not been validated for v1.
- **WSL2 NAT mode does not work cross-machine.** Default WSL2 networking blocks the inbound UDP that WebRTC ICE needs. Enable WSL2 mirrored mode (Win11 22H2+) per the "Running on WSL2" section above for direct peer-to-peer, or configure your own TURN via the `turn_servers` userConfig. Run `/claude-rooms:rooms-doctor` to see which path you are on; the command runs a live ICE probe and tells you whether your config produces a `relay` candidate.
- **Public signaling servers are community-run.** y-webrtc ships with three defaults (`wss://signaling.yjs.dev` and two heroku instances). They can rate-limit or briefly go offline. v1 does not expose an override for this; the room code remains the same regardless.
- **Mesh degrades past ~6 peers.** claude-rooms is built for pairs and small groups. Larger rooms will work technically, but the mesh topology is not optimised for them.
- **No default TURN relay.** About 5% of users on aggressive symmetric NATs and most WSL2-NAT users will not be able to connect cross-machine without configuring their own TURN. There is no reliable free anonymous public TURN endpoint to bake in (Open Relay's anonymous tier was tried and proven dead in 0.3.0). Use mirrored mode on Windows, native Linux/macOS, or set `turn_servers` to a relay you control or pay for.

## Status

This is v1.2.1 (`0.3.1` in `plugin.json`). The deferred-to-v2 list lives in the Roadmap section above; see [CLAUDE.md](./CLAUDE.md) for design rationale and the original v1 trade-off list. Bug fixes bump the patch version in `plugin.json`; you receive updates via `/plugin update`.

## License

MIT. See [LICENSE](./LICENSE).
