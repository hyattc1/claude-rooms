import { callOnce } from "../ipc.js";

export function getSessionId(): string | null {
  return process.env.CLAUDE_CODE_SESSION_ID ?? null;
}

export interface IpcCallOpts {
  timeoutMs?: number;
}

/** Convenience wrapper: hand callOnce the current session id (for the
 *  by-session manifest) and ppid (for the by-ppid manifest fallback). */
export async function ipcCall<R = unknown>(
  method: string,
  params: unknown,
  opts: IpcCallOpts = {}
): Promise<R | null> {
  const sessionId = getSessionId() ?? undefined;
  return callOnce<R>(method, params, {
    sessionId,
    ppid: process.ppid,
    cwdForFallback: process.cwd(),
  }, opts.timeoutMs ?? 2000);
}

export function exitWith(text: string, code = 0): never {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  process.exit(code);
}
