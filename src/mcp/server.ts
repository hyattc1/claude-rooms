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
import * as Y from "yjs";

import { IpcServer } from "../ipc.js";
import { readSessionState } from "../session-store.js";
import {
  Room,
  type ActorState,
  type ActionEvent,
  type RoomSnapshot,
  type GitState,
  type TerritoryOverlap,
} from "../shared-state.js";

const SERVER_NAME = "claude-rooms";
const SERVER_VERSION = "0.2.0";

// Test mode is opt-in via env var. When set, the MCP server skips the
// y-webrtc connection AND shares a single Y.Doc per room_code across all
// sessions in the same MCP process. This lets two test sessions in the
// same process exercise the cross-actor lock / state behaviour exactly as
// real WebRTC-synced peers would.
const TEST_MODE = process.env.CLAUDE_ROOMS_TEST_MODE === "1";

class RoomManager {
  private rooms = new Map<string, Room>(); // keyed on session id
  private sharedDocs = new Map<string, Y.Doc>(); // test-mode: room_code -> Y.Doc

  ensureRoomSync(sessionId: string): Room | null {
    const ss = readSessionState(sessionId);
    if (!ss) {
      this.removeRoom(sessionId);
      return null;
    }
    const existing = this.rooms.get(sessionId);
    if (existing && existing.roomCode === ss.room_code) return existing;
    if (existing) this.removeRoom(sessionId);
    let ydoc: Y.Doc | undefined;
    if (TEST_MODE) {
      ydoc = this.sharedDocs.get(ss.room_code);
      if (!ydoc) {
        ydoc = new Y.Doc();
        this.sharedDocs.set(ss.room_code, ydoc);
      }
    }
    const room = new Room(ss.room_code, ss.actor_name, ydoc ? { ydoc } : {});
    room.connect(TEST_MODE ? { testMode: true } : {});
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

const UPDATE_MY_PLAN_DESC = `Share a compact summary of the multi-step plan you are currently executing, so teammates can see your progress at a glance. Call this:
- When you enter plan mode and produce a plan: set summary (one short phrase), steps_total to the number of top-level checklist items, steps_done to 0.
- When the user approves and you start executing: leave summary and steps_total alone, bump steps_done as you complete each step.
- When the plan is complete: call with steps_done equal to steps_total, or simply stop calling and the next plan call replaces this one.
For tasks that do not have a multi-step plan, do not call this tool. A small one-off edit does not need a plan.`;

const CLAIM_TERRITORY_DESC = `Tell teammates which areas of the codebase you intend to work in for the current task. Globs are gitignore-style patterns relative to your project root. Purpose is a short phrase describing what you are doing. The MCP server replaces your previous claim, if any.

Call this at the start of any substantial task. Examples:
- ['src/auth/**', 'src/middleware/auth.ts'] for an auth refactor.
- ['src/api/users.*', 'tests/users.*'] for a users endpoint.
- ['docs/**'] for documentation work.

Teammates' agents will see your claim and route around it at the planning stage, before any edit-attempt conflict. Calling this is cheap. Skip it only for genuinely tiny tasks that touch one or two files you can name explicitly to the user.`;

const RELEASE_TERRITORY_DESC = `Drop your current territory claim. Call this when the task is ending or when you are shifting to a different area of the codebase.`;

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

  // ---- v1.1 IPC methods ----

  ipc.on<{ session_id: string; state: GitState | null; include_commits?: boolean }>(
    "update_my_git",
    ({ session_id, state, include_commits }) => {
      adopt(session_id);
      const room = ctx.manager.ensureRoomSync(session_id);
      if (!room) return { applied: false };
      room.mergeGitState(state, { includeCommits: !!include_commits });
      return { applied: true };
    }
  );

  ipc.on<{
    session_id: string;
    in_plan_mode?: boolean;
    summary?: string;
    steps_total?: number;
    steps_done?: number;
  }>("update_my_plan", ({ session_id, in_plan_mode, summary, steps_total, steps_done }) => {
    adopt(session_id);
    const room = ctx.manager.ensureRoomSync(session_id);
    if (!room) return { applied: false };
    const patch: Record<string, unknown> = {};
    if (typeof in_plan_mode === "boolean") patch.in_plan_mode = in_plan_mode;
    if (typeof summary === "string") patch.summary = summary;
    if (typeof steps_total === "number") patch.steps_total = steps_total;
    if (typeof steps_done === "number") patch.steps_done = steps_done;
    room.updatePlan(patch);
    return { applied: true };
  });

  ipc.on<{ session_id: string; text: string | null }>(
    "set_last_prompt",
    ({ session_id, text }) => {
      adopt(session_id);
      const room = ctx.manager.ensureRoomSync(session_id);
      if (!room) return { applied: false };
      if (text == null) {
        room.setLastPrompt(null);
      } else {
        room.setLastPrompt({ text, at_ms: Date.now() });
      }
      return { applied: true };
    }
  );

  ipc.on<{ session_id: string; globs: string[]; purpose: string; ttl_ms?: number }>(
    "claim_territory",
    ({ session_id, globs, purpose, ttl_ms }) => {
      adopt(session_id);
      const room = ctx.manager.ensureRoomSync(session_id);
      if (!room) return { claimed: false };
      const claim = room.claimTerritory(globs ?? [], purpose ?? "", ttl_ms);
      return { claimed: true, claim };
    }
  );

  ipc.on<{ session_id: string }>("release_territory", ({ session_id }) => {
    adopt(session_id);
    const room = ctx.manager.ensureRoomSync(session_id);
    if (!room) return { released: false };
    room.releaseTerritory();
    return { released: true };
  });

  ipc.on<{ session_id: string; files: string[] }>(
    "check_territory_overlap",
    ({ session_id, files }) => {
      adopt(session_id);
      const room = ctx.manager.ensureRoomSync(session_id);
      if (!room) return { overlaps: [] as TerritoryOverlap[] };
      return { overlaps: room.checkTerritoryOverlap(files ?? []) };
    }
  );

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

  mcp.registerTool(
    "update_my_plan",
    {
      description: UPDATE_MY_PLAN_DESC,
      inputSchema: {
        summary: z.string().min(1).max(200)
          .describe('Short phrase describing the plan, e.g. "add /users endpoint with pagination".'),
        steps_total: z.number().int().min(0).max(100)
          .describe("Number of top-level checklist items in the plan."),
        steps_done: z.number().int().min(0).max(100)
          .describe("Number of steps completed so far. 0 when the plan is fresh."),
      },
    },
    async ({ summary, steps_total, steps_done }) => {
      const sid = ctx.activeSessionId ?? getCallerSessionIdFromEnv();
      if (!sid) {
        return { content: [{ type: "text", text: "Not in a room; cannot update plan." }] };
      }
      const room = ctx.manager.ensureRoomSync(sid);
      if (!room) {
        return { content: [{ type: "text", text: "Not in a room; cannot update plan." }] };
      }
      room.updatePlan({ summary, steps_total, steps_done });
      return {
        content: [{ type: "text", text: `Plan: ${summary} (${steps_done}/${steps_total})` }],
      };
    }
  );

  mcp.registerTool(
    "claim_territory",
    {
      description: CLAIM_TERRITORY_DESC,
      inputSchema: {
        globs: z.array(z.string().min(1)).min(1).max(20)
          .describe("Gitignore-style glob patterns, relative to project root."),
        purpose: z.string().min(1).max(200)
          .describe("Short phrase describing the task."),
      },
    },
    async ({ globs, purpose }) => {
      const sid = ctx.activeSessionId ?? getCallerSessionIdFromEnv();
      if (!sid) {
        return { content: [{ type: "text", text: "Not in a room; cannot claim territory." }] };
      }
      const room = ctx.manager.ensureRoomSync(sid);
      if (!room) {
        return { content: [{ type: "text", text: "Not in a room; cannot claim territory." }] };
      }
      room.claimTerritory(globs, purpose);
      return {
        content: [{ type: "text", text: `Claimed territory: ${globs.join(", ")} (${purpose})` }],
      };
    }
  );

  mcp.registerTool(
    "release_territory",
    {
      description: RELEASE_TERRITORY_DESC,
      inputSchema: {},
    },
    async () => {
      const sid = ctx.activeSessionId ?? getCallerSessionIdFromEnv();
      if (!sid) {
        return { content: [{ type: "text", text: "Not in a room; nothing to release." }] };
      }
      const room = ctx.manager.ensureRoomSync(sid);
      if (!room) {
        return { content: [{ type: "text", text: "Not in a room; nothing to release." }] };
      }
      room.releaseTerritory();
      return { content: [{ type: "text", text: "Territory released." }] };
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
