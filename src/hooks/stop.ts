// Stop hook: when the agent finishes a turn, snapshot the most recent
// action into recent_actions so the next read_room_state call surfaces it.
// v1.1: also publish a full git refresh (with commits) and the plan-mode flag.

import { hookIpc, readStdinJson, inPlanMode, warn } from "./_common.js";
import { readGitState } from "../git-state.js";

async function main(): Promise<void> {
  const input = readStdinJson();
  const sessionId = input.session_id ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) return;

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

  // v1.1: full git refresh (commits included; throttled MCP-side to 5s).
  const cwd = input.cwd ?? process.cwd();
  const git = readGitState(cwd, { includeCommits: true });
  await hookIpc(
    "update_my_git",
    { session_id: sessionId, state: git, include_commits: true },
    sessionId
  );
  await hookIpc(
    "update_my_plan",
    { session_id: sessionId, in_plan_mode: inPlanMode(input) },
    sessionId
  );
}

main().catch((e) => {
  warn(`stop: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0); // fail open
});
