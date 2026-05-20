// SessionStart hook: when a Claude Code session starts/resumes/clears,
// inject the room's current teammate snapshot as additionalContext.
// If we are not in a room or MCP is unreachable, fail open: emit nothing.

import { readSessionState } from "../session-store.js";
import { hookIpc, readStdinJson, emitHookOutput, warn } from "./_common.js";

interface ActorLite {
  actor: string;
  focus: string;
  branch: string;
  online: boolean;
  files_open: string[];
  last_action: { type: string; summary?: string; timestamp_ms: number } | null;
  recent_actions: Array<{ type: string; summary?: string }>;
}

interface Snapshot {
  room_code: string;
  me: string;
  actors: ActorLite[];
  locks: Array<{ file: string; entry: { actor: string } }>;
  online_peer_count: number;
}

interface GetStateResp {
  in_room: boolean;
  snapshot?: Snapshot;
}

function formatContext(snap: Snapshot): string {
  const others = snap.actors.filter((a) => a.actor !== snap.me);
  const teammateLines: string[] = [];
  if (others.length === 0) {
    teammateLines.push("No teammates currently online. The room is yours for now.");
  } else {
    for (const a of others) {
      const status = a.online ? "online" : "offline";
      const branchPart = a.branch ? `, branch ${a.branch}` : "";
      let block = `- ${a.actor} (${status}${branchPart})`;
      if (a.focus) block += `\n  Focus: ${a.focus}`;
      if (a.last_action) {
        const s = a.last_action.summary ? ` - ${a.last_action.summary}` : "";
        block += `\n  Last action: ${a.last_action.type}${s}`;
      }
      if (a.files_open && a.files_open.length > 0) {
        block += `\n  Recent files: ${a.files_open.slice(-5).join(", ")}`;
      }
      teammateLines.push(block);
    }
  }
  const lockLines = snap.locks.length === 0
    ? "No active file locks."
    : snap.locks.map((l) => `- ${l.file} (held by ${l.entry.actor})`).join("\n");

  return (
    `## Room: ${snap.room_code}\n` +
    `\n` +
    `You are in a multiplayer Claude Code room. Other developers are running their own Claude Code sessions in the same room, and their agents share live state with yours.\n` +
    `\n` +
    `Teammates currently in this room:\n` +
    teammateLines.join("\n") +
    `\n\n` +
    `Active file locks:\n${lockLines}\n` +
    `\n` +
    `Tools available for staying in sync:\n` +
    `- read_room_state: fetch the live state of every teammate. Fast local query. Call often.\n` +
    `- update_my_focus: tell teammates what you are working on.\n` +
    `\n` +
    `File-edit coordination: every edit (Write/Edit/MultiEdit) is checked against shared locks. If a teammate is currently editing a file, your edit will be blocked with a clear message naming them. Do not panic; route around it or coordinate with the user.\n` +
    `\n` +
    `The room is live: your view of teammates updates continuously, not just at session start. Use read_room_state during your turn whenever you suspect a teammate's work may have changed the ground truth.`
  );
}

async function main(): Promise<void> {
  const input = readStdinJson();
  const sessionId = input.session_id ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) return; // fail open

  const local = readSessionState(sessionId);
  if (!local) return; // not in a room

  const resp = await hookIpc<GetStateResp>("get_state", { session_id: sessionId }, sessionId);
  if (!resp || !resp.in_room || !resp.snapshot) {
    // MCP unreachable or has not yet ingested the session-store. Emit a minimal
    // context so the agent at least knows it is in a room.
    emitHookOutput({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `## Room: ${local.room_code}\nYou are in claude-rooms as ${local.actor_name}. Teammate state will appear once the MCP server connects. Call read_room_state during your turn for the latest.`,
      },
    });
    return;
  }
  const text = formatContext(resp.snapshot);
  emitHookOutput({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: text,
    },
  });
}

main().catch((e) => {
  warn(`session-start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0); // fail open
});
