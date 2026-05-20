// SessionEnd hook: tell the MCP server we are leaving. The server releases
// our locks, marks us offline, and (in our shared-state library)
// destroys awareness, which is the signal other peers' awareness reapers
// use to clean up our locks within the y-protocols 30-second timeout.

import { hookIpc, readStdinJson, warn } from "./_common.js";

async function main(): Promise<void> {
  const input = readStdinJson();
  const sessionId = input.session_id ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) return;
  await hookIpc("mark_offline", { session_id: sessionId }, sessionId, 1000);
}

main().catch((e) => {
  warn(`session-end: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0); // fail open
});
