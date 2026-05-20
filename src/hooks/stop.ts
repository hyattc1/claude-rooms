// Stop hook: when the agent finishes a turn, snapshot the most recent
// action into recent_actions so the next read_room_state call surfaces it.
// In v1 we delegate the rotation to the MCP server via record_action; if
// there is no last_action yet, this is a no-op.

import { hookIpc, readStdinJson, warn } from "./_common.js";

async function main(): Promise<void> {
  const input = readStdinJson();
  const sessionId = input.session_id ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) return;

  // Tell the MCP server we have finished a turn. The MCP server reads our
  // last_action and rotates it into recent_actions. If last_action is null
  // the rotation is a no-op.
  await hookIpc(
    "record_action",
    {
      session_id: sessionId,
      action: {
        type: "turn_end",
        files: [],
        summary: typeof input.stop_reason === "string" ? input.stop_reason : "end_turn",
        timestamp_ms: Date.now(),
      },
    },
    sessionId
  );
}

main().catch((e) => {
  warn(`stop: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0); // fail open
});
