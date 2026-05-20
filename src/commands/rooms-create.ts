import { generateRoomCode } from "../room-code.js";
import { resolveActorName } from "../actor.js";
import { writeSessionState } from "../session-store.js";
import { getSessionId, ipcCall, exitWith } from "./_common.js";

async function main(): Promise<void> {
  const sessionId = getSessionId();
  if (!sessionId) {
    exitWith("claude-rooms: CLAUDE_CODE_SESSION_ID is not set. Are you running inside Claude Code?", 1);
  }
  const code = generateRoomCode();
  const actor = resolveActorName();
  writeSessionState(sessionId, {
    room_code: code,
    actor_name: actor,
    joined_at_ms: Date.now(),
  });
  // Wake the MCP server: this triggers ensureRoomSync and starts the
  // y-webrtc connection in the background, so the room is "live" by the
  // time the user shares the code.
  await ipcCall("room_status", { session_id: sessionId });
  exitWith(
    `Room: ${code}\n` +
    `You are joined as ${actor}.\n` +
    `Share this code with your teammate: /claude-rooms:rooms-join ${code}\n` +
    `(They can also use /rooms-join ${code} if the plugin shorthand is enabled.)`
  );
}

main().catch((e) => {
  process.stderr.write(`claude-rooms: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
