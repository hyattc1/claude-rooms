import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { callOnce } from "../ipc.js";

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  stop_reason?: string;
  reason?: string;
  source?: string;
  [k: string]: unknown;
}

/** Read the hook's stdin JSON. Returns an empty object on any error. */
export function readStdinJson(): HookInput {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw) as HookInput;
  } catch {
    return {};
  }
}

/** IPC call with sensible discovery defaults for hooks. Returns null on
 *  any failure so callers can fail open. */
export async function hookIpc<R = unknown>(
  method: string,
  params: unknown,
  sessionId: string | undefined,
  timeoutMs = 1500
): Promise<R | null> {
  return callOnce<R>(method, params, {
    sessionId,
    ppid: process.ppid,
    cwdForFallback: process.cwd(),
  }, timeoutMs);
}

/** Try to detect the current git branch. Best-effort; returns "" on failure. */
export function detectBranch(): string {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    });
    return out.trim();
  } catch {
    return "";
  }
}

/** Emit hookSpecificOutput JSON on stdout. */
export function emitHookOutput(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

export function warn(msg: string): void {
  process.stderr.write(`claude-rooms hook: ${msg}\n`);
}
