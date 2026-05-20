import { clearSessionState, readSessionState } from "../session-store.js";
import { getSessionId, ipcCall, exitWith } from "./_common.js";

async function main(): Promise<void> {
  const sessionId = getSessionId();
  if (!sessionId) {
    exitWith("claude-rooms: CLAUDE_CODE_SESSION_ID is not set. Are you running inside Claude Code?", 1);
  }
  const cur = readSessionState(sessionId);
  if (!cur) {
    exitWith("You are not currently in a room.");
  }
  // Best-effort IPC: tell the MCP server to release locks and mark us offline.
  await ipcCall("mark_offline", { session_id: sessionId });
  clearSessionState(sessionId);
  exitWith(`Left room ${cur.room_code}.`);
}

main().catch((e) => {
  process.stderr.write(`claude-rooms: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
