// The MCP server. Long-lived for the duration of one Claude Code session;
// owns the y-webrtc connection (lazy) and the live Y.Doc. Exposes two
// surfaces:
//
//   1. Agent-facing MCP tools (read_room_state, update_my_focus) via stdio
//      MCP protocol. The tool descriptions (Section 12 of the plan) coach
//      the agent to call read_room_state liberally.
//
//   2. Hook-facing IPC methods over a Unix domain socket: get_state,
//      set_my_state, try_acquire_locks, release_locks, refresh_lock_ttl,
//      mark_offline, room_status. Hooks and slash commands call these to
//      stay coordinated with the live Y.Doc without each opening their own
//      WebRTC connection.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { IpcServer } from "../ipc.js";
import { readSessionState } from "../session-store.js";
import { Room, type ActorState, type ActionEvent, type RoomSnapshot } from "../shared-state.js";

const SERVER_NAME = "claude-rooms";
const SERVER_VERSION = "0.1.0";

class RoomManager {
  private rooms = new Map<string, Room>(); // keyed on session id
  private connecting = new Map<string, Promise<Room | null>>();

  ensureRoomSync(sessionId: string): Room | null {
    const ss = readSessionState(sessionId);
    if (!ss) {
      this.removeRoom(sessionId);
      return null;
    }
    const existing = this.rooms.get(sessionId);
    if (existing && existing.roomCode === ss.room_code) return existing;
    if (existing) this.removeRoom(sessionId);
    const room = new Room(ss.room_code, ss.actor_name);
    room.connect();
    this.rooms.set(sessionId, room);
    return room;
  }

  /** Drop the room for this session (e.g. on /rooms-leave). */
  async removeRoom(sessionId: string): Promise<void> {
    const r = this.rooms.get(sessionId);
    if (!r) return;
    this.rooms.delete(sessionId);
    try { await r.disconnect(); } catch { /* ignore */ }
  }

  rooms_iter(): IterableIterator<[string, Room]> {
    return this.rooms.entries();
  }

  async shutdownAll(): Promise<void> {
    for (const [, room] of this.rooms) {
      try { room.markOffline(); } catch { /* ignore */ }
    }
    for (const [, room] of this.rooms) {
      try { await room.disconnect(); } catch { /* ignore */ }
    }
    this.rooms.clear();
  }
}

// --- Tool descriptions (Section 12 of the plan, verbatim). ---

const READ_ROOM_STATE_DESC = `Returns the live state of every other developer's agent in this room. Each teammate's entry includes their current focus, the files they have recently touched, what they just did, and any files they currently hold locks on. This is a fast local query against a shared CRDT; calling it is cheap and you should do so liberally.

Call this:
- Before starting any new unit of work, to check whether a teammate is already working on something related.
- Before reading or editing a file you have not touched recently, to check whether a teammate has changed it.
- Any time the user mentions a teammate by name, a branch name, or a file you know a teammate has been working on.
- Periodically during long-running tasks, so you stay in sync.

When you see a teammate's recent activity that may affect your work, factor it into your plan and tell the user about it. Their work changes the ground truth you are operating on.`;

const UPDATE_MY_FOCUS_DESC = `Sets a short description of what you are currently working on, so teammates' agents can see it. Call this when the user gives you a new task, when the focus of the current task shifts significantly, or when you start a new sub-task. Keep the description short (one phrase, lowercase, like "refactoring auth middleware" or "writing tests for users endpoint").`;

// --- Helpers ---

function getCallerSessionIdFromEnv(): string | null {
  // MCP tool calls do NOT carry session_id. The MCP server reads the env at
  // startup; this may be stale (Phase 0 spike), so use it only as a last
  // resort. In practice, by the time a tool fires, at least one hook has
  // arrived via IPC with an authoritative session id.
  return process.env.CLAUDE_CODE_SESSION_ID ?? null;
}

interface CtxState {
  /** The session id we have seen on any IPC call. The first one wins. */
  activeSessionId: string | null;
  manager: RoomManager;
  ipc: IpcServer;
}

function formatTeammates(snap: RoomSnapshot): string {
  const others = snap.actors.filter((a) => a.actor !== snap.me);
  if (others.length === 0) {
    return "No other teammates currently online in this room.";
  }
  const lines: string[] = [];
  for (const a of others) {
    const status = a.online ? "online" : "offline";
    const focusPart = a.focus ? `\n  Focus: ${a.focus}` : "";
    const branchPart = a.branch ? ` (branch ${a.branch})` : "";
    const lastPart = a.last_action
      ? `\n  Last action: ${a.last_action.type}${a.last_action.summary ? " - " + a.last_action.summary : ""}`
      : "";
    const filesPart = a.files_open && a.files_open.length > 0
      ? `\n  Recent files: ${a.files_open.slice(-5).join(", ")}`
      : "";
    lines.push(`- ${a.actor} (${status})${branchPart}${focusPart}${lastPart}${filesPart}`);
  }
  return lines.join("\n");
}

function formatLocks(snap: RoomSnapshot): string {
  if (snap.locks.length === 0) return "No active locks.";
  return snap.locks
    .map((l) => `- ${l.file} (held by ${l.entry.actor})`)
    .join("\n");
}

// --- Main ---

async function main(): Promise<void> {
  const ctx: CtxState = {
    activeSessionId: null,
    manager: new RoomManager(),
    ipc: new IpcServer({
      onSessionIdLearned: (sid) => {
        if (!ctx.activeSessionId) ctx.activeSessionId = sid;
      },
    }),
  };

  // ---- IPC methods (hook + slash-command facing) ----

  const ipc = ctx.ipc;

  function adopt(sessionId: string): void {
    if (sessionId && !ctx.activeSessionId) ctx.activeSessionId = sessionId;
    if (sessionId) ipc.publishBySession(sessionId);
  }

  ipc.on<{ session_id: string }>("get_state", ({ session_id }) => {
    adopt(session_id);
    const room = ctx.manager.ensureRoomSync(session_id);
    if (!room) return { in_room: false };
    return { in_room: true, snapshot: room.getSnapshot() };
  });

  ipc.on<{ session_id: string; patch: Partial<ActorState> }>("set_my_state", ({ session_id, patch }) => {
    adopt(session_id);
    const room = ctx.manager.ensureRoomSync(session_id);
    if (!room) return { applied: false };
    room.setMyState(patch);
    return { applied: true };
  });

  ipc.on<{ session_id: string; action: ActionEvent }>("record_action", ({ session_id, action }) => {
    adopt(session_id);
    const room = ctx.manager.ensureRoomSync(session_id);
    if (!room) return { applied: false };
    room.recordAction(action);
    return { applied: true };
  });

  ipc.on<{ session_id: string; files: string[] }>("try_acquire_locks", ({ session_id, files }) => {
    adopt(session_id);
    const room = ctx.manager.ensureRoomSync(session_id);
    if (!room) return { ok: true, in_room: false };
    return { ...room.tryAcquireLocks(files), in_room: true };
  });

  ipc.on<{ session_id: string; files: string[] }>("release_locks", ({ session_id, files }) => {
    adopt(session_id);
    const room = ctx.manager.ensureRoomSync(session_id);
    if (!room) return { released: false };
    room.releaseLocks(files);
    return { released: true };
  });

  ipc.on<{ session_id: string; files: string[] }>("refresh_lock_ttl", ({ session_id, files }) => {
    adopt(session_id);
    const room = ctx.manager.ensureRoomSync(session_id);
    if (!room) return { refreshed: false };
    room.refreshLockTtl(files);
    return { refreshed: true };
  });

  ipc.on<{ session_id: string }>("mark_offline", async ({ session_id }) => {
    adopt(session_id);
    const room = ctx.manager.ensureRoomSync(session_id);
    if (room) {
      room.markOffline();
    }
    await ctx.manager.removeRoom(session_id);
    return { ok: true };
  });

  ipc.on<{ session_id: string }>("room_status", ({ session_id }) => {
    adopt(session_id);
    const room = ctx.manager.ensureRoomSync(session_id);
    if (!room) return { in_room: false };
    const snap = room.getSnapshot();
    return {
      in_room: true,
      room_code: snap.room_code,
      me: snap.me,
      online_peer_count: snap.online_peer_count,
      peer_actors: snap.actors.filter((a) => a.actor !== snap.me).map((a) => ({
        actor: a.actor,
        online: a.online,
        focus: a.focus,
      })),
    };
  });

  await ipc.start();

  // ---- MCP server (agent-facing) ----

  const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  mcp.registerTool(
    "read_room_state",
    {
      description: READ_ROOM_STATE_DESC,
      inputSchema: {},
    },
    async () => {
      const sid = ctx.activeSessionId ?? getCallerSessionIdFromEnv();
      if (!sid) {
        return {
          content: [{ type: "text", text: "You are not in a room yet. Use /rooms-create or /rooms-join <code>." }],
        };
      }
      const room = ctx.manager.ensureRoomSync(sid);
      if (!room) {
        return {
          content: [{ type: "text", text: "You are not in a room. Use /rooms-create or /rooms-join <code> first." }],
        };
      }
      const snap = room.getSnapshot();
      const teammates = formatTeammates(snap);
      const locks = formatLocks(snap);
      const text = `Room: ${snap.room_code}\nYou: ${snap.me}\n\nTeammates:\n${teammates}\n\nLocks:\n${locks}`;
      return {
        content: [{ type: "text", text }],
        structuredContent: snap as unknown as Record<string, unknown>,
      };
    }
  );

  mcp.registerTool(
    "update_my_focus",
    {
      description: UPDATE_MY_FOCUS_DESC,
      inputSchema: {
        focus: z
          .string()
          .min(1)
          .max(200)
          .describe('Short lowercase phrase, e.g. "refactoring auth middleware".'),
      },
    },
    async ({ focus }) => {
      const sid = ctx.activeSessionId ?? getCallerSessionIdFromEnv();
      if (!sid) {
        return {
          content: [{ type: "text", text: "Not in a room; cannot update focus. Run /rooms-create or /rooms-join first." }],
        };
      }
      const room = ctx.manager.ensureRoomSync(sid);
      if (!room) {
        return {
          content: [{ type: "text", text: "Not in a room; cannot update focus. Run /rooms-create or /rooms-join first." }],
        };
      }
      room.setMyState({ focus });
      room.flushMyState();
      return {
        content: [{ type: "text", text: `Updated focus: ${focus}` }],
      };
    }
  );

  // Graceful shutdown.
  const shutdown = async (): Promise<void> => {
    try { await ctx.manager.shutdownAll(); } catch { /* ignore */ }
    try { await ctx.ipc.stop(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGTERM", () => { void shutdown(); });
  process.on("SIGINT", () => { void shutdown(); });
  // When the MCP stdio transport closes (parent Claude Code shutting us
  // down), Node will see stdin end. Trigger shutdown in that case too.
  process.stdin.on("end", () => { void shutdown(); });

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch((err) => {
  console.error("claude-rooms MCP server fatal:", err);
  process.exit(1);
});
