// PreToolUse hook on Write|Edit|MultiEdit. Synchronously checks shared
// locks via IPC; denies with a structured JSON response if a teammate
// holds the file, otherwise allows. Always fails open on any internal
// error (claude-rooms must never block your edits because IT is broken).

import { resolve as resolvePath, isAbsolute } from "node:path";
import { hookIpc, readStdinJson, emitHookOutput, warn } from "./_common.js";

interface TryAcquireResp {
  ok: boolean;
  in_room?: boolean;
  held?: Array<{ file: string; actor: string }>;
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

function buildAllowReminder() {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        "claude-rooms file-edit coordination checked the shared locks before this edit. " +
        "If a teammate had been editing this file, you would have been blocked. " +
        "Consider calling read_room_state if you have not recently, to stay aware of teammate activity.",
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

  const resp = await hookIpc<TryAcquireResp>(
    "try_acquire_locks",
    { session_id: sessionId, files },
    sessionId
  );
  if (!resp) return; // MCP unreachable; allow
  if (resp.in_room === false) return; // not in a room; allow
  if (resp.ok) {
    emitHookOutput(buildAllowReminder());
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
