// PreToolUse hook on Write|Edit|MultiEdit. Synchronously checks shared
// locks via IPC; denies with a structured JSON response if a teammate
// holds the file, otherwise allows. v1.1: when allowing, also queries
// teammate territory claims and appends a soft warning if the file is
// inside a teammate's territory. Always fails open on any internal error.

import { resolve as resolvePath, isAbsolute } from "node:path";
import { hookIpc, readStdinJson, emitHookOutput, inPlanMode, warn } from "./_common.js";

interface TryAcquireResp {
  ok: boolean;
  in_room?: boolean;
  held?: Array<{ file: string; actor: string }>;
}

interface TerritoryOverlapResp {
  overlaps: Array<{ file: string; teammate: string; purpose: string }>;
}

/** Extract the file paths a tool call wants to touch.
 *  Write/Edit: tool_input.file_path is a single string.
 *  MultiEdit (current schema as of Claude Code 2.1.x): tool_input.file_path
 *  is a single string; edits[] is an array of {old_string, new_string, replace_all}.
 *  We also defensively support a hypothetical multi-file shape where each
 *  edit carries its own file_path.
 */
function extractFiles(toolInput: Record<string, unknown> | undefined, cwd: string): string[] {
  if (!toolInput) return [];
  const out = new Set<string>();
  const top = toolInput["file_path"];
  if (typeof top === "string" && top.length > 0) out.add(absolutize(top, cwd));
  const edits = toolInput["edits"];
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (e && typeof e === "object" && typeof (e as Record<string, unknown>).file_path === "string") {
        const fp = (e as Record<string, unknown>).file_path as string;
        if (fp.length > 0) out.add(absolutize(fp, cwd));
      }
    }
  }
  return [...out];
}

function absolutize(file: string, cwd: string): string {
  return isAbsolute(file) ? file : resolvePath(cwd, file);
}

function buildDenyOutput(held: Array<{ file: string; actor: string }>) {
  const lines = held.map((h) => `${h.file} is currently held by ${h.actor}`);
  const reason = lines.join("; ") + ".";
  const additional =
    "Run /rooms-status to see all current locks. " +
    "Consider editing a different file, asking the teammate in your usual channel, " +
    "or asking the user how they want to proceed. " +
    "Also call read_room_state to see what the teammate is working on.";
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
      additionalContext: additional,
    },
  };
}

function buildAllowReminder(
  overlaps: Array<{ file: string; teammate: string; purpose: string }>
) {
  let body =
    "claude-rooms file-edit coordination checked the shared locks before this edit. " +
    "Consider calling read_room_state to stay aware of teammate activity.";
  if (overlaps.length > 0) {
    const overlapLines = overlaps.map(
      (o) =>
        `Note: ${o.file} is in ${o.teammate}'s claimed territory ("${o.purpose}"). ` +
        "Your edit is proceeding because no lock is held, but consider whether to coordinate."
    );
    body += "\n" + overlapLines.join("\n");
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: body,
    },
  };
}

async function main(): Promise<void> {
  const input = readStdinJson();
  const sessionId = input.session_id ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) return; // fail open

  const cwd = input.cwd ?? process.cwd();
  const files = extractFiles(input.tool_input as Record<string, unknown> | undefined, cwd);
  if (files.length === 0) return; // nothing to lock; allow

  // Publish plan-mode flag in the background. Best-effort, do not block.
  void hookIpc(
    "update_my_plan",
    { session_id: sessionId, in_plan_mode: inPlanMode(input) },
    sessionId,
    500
  );

  const resp = await hookIpc<TryAcquireResp>(
    "try_acquire_locks",
    { session_id: sessionId, files },
    sessionId
  );
  if (!resp) return; // MCP unreachable; allow
  if (resp.in_room === false) return; // not in a room; allow
  if (resp.ok) {
    // Lock acquired. Check for soft territory overlap and include in reminder.
    const overlapResp = await hookIpc<TerritoryOverlapResp>(
      "check_territory_overlap",
      { session_id: sessionId, files },
      sessionId,
      800
    );
    const overlaps = overlapResp?.overlaps ?? [];
    emitHookOutput(buildAllowReminder(overlaps));
    return;
  }
  if (resp.held && resp.held.length > 0) {
    emitHookOutput(buildDenyOutput(resp.held));
    return;
  }
  // ok === false but no held? defensive: allow.
}

main().catch((e) => {
  warn(`pre-edit: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0); // fail open
});
