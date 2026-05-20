// PostToolUse hook on Write|Edit|MultiEdit. Records the edit in our actor
// state, refreshes the lock TTL on the touched files, publishes a light
// git refresh (no commits), and forwards the current plan-mode flag.

import { resolve as resolvePath, isAbsolute } from "node:path";
import { hookIpc, readStdinJson, detectBranch, inPlanMode, warn } from "./_common.js";
import { readGitStateLight } from "../git-state.js";
import type { ActionEvent } from "../shared-state.js";

function absolutize(file: string, cwd: string): string {
  return isAbsolute(file) ? file : resolvePath(cwd, file);
}

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

function summarize(toolName: string, files: string[]): string {
  if (files.length === 0) return toolName.toLowerCase();
  if (files.length === 1) return `${toolName.toLowerCase()} ${files[0]}`;
  return `${toolName.toLowerCase()} ${files[0]} (+${files.length - 1} more)`;
}

async function main(): Promise<void> {
  const input = readStdinJson();
  const sessionId = input.session_id ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) return;

  const cwd = input.cwd ?? process.cwd();
  const files = extractFiles(input.tool_input as Record<string, unknown> | undefined, cwd);

  const action: ActionEvent = {
    type: typeof input.tool_name === "string" ? input.tool_name.toLowerCase() : "edit",
    files,
    summary: summarize(typeof input.tool_name === "string" ? input.tool_name : "edit", files),
    timestamp_ms: Date.now(),
  };

  const branch = detectBranch();

  await hookIpc(
    "set_my_state",
    {
      session_id: sessionId,
      patch: {
        last_action: action,
        branch,
        files_open: files,
      },
    },
    sessionId
  );

  if (files.length > 0) {
    await hookIpc("refresh_lock_ttl", { session_id: sessionId, files }, sessionId);
  }

  // v1.1: publish a light git refresh and the plan-mode flag.
  const git = readGitStateLight(cwd);
  await hookIpc(
    "update_my_git",
    { session_id: sessionId, state: git, include_commits: false },
    sessionId
  );
  await hookIpc(
    "update_my_plan",
    { session_id: sessionId, in_plan_mode: inPlanMode(input) },
    sessionId
  );
}

main().catch((e) => {
  warn(`post-edit: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0); // fail open
});
