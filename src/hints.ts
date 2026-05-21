// One-time-per-session hint helper.
//
// The SessionStart hook may emit multiple advisory hints to the agent
// (share_prompts default-off, WSL2 NAT mode, future ones). Each hint should
// fire at most once per Claude Code session so the agent does not see the
// same paragraph at the top of every resumed turn.
//
// State is persisted to ${CLAUDE_PLUGIN_DATA}/sessions/<sid>.hints.json with
// shape `{ shown: ["share-prompts", "wsl-nat"] }`. The file is wiped from
// session-store.clearSessionState() when the user leaves a room.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function pluginDataDir(): string {
  return process.env.CLAUDE_PLUGIN_DATA ?? "";
}

function validSessionId(sid: string): boolean {
  return /^[A-Za-z0-9_.\-]+$/.test(sid);
}

export function hintsFilePath(sessionId: string): string {
  if (!validSessionId(sessionId)) {
    throw new Error(`invalid session id: ${sessionId}`);
  }
  return join(pluginDataDir(), "sessions", `${sessionId}.hints.json`);
}

interface HintsFile {
  shown: string[];
}

function readHints(sessionId: string): HintsFile {
  if (!pluginDataDir() || !sessionId) return { shown: [] };
  let p: string;
  try { p = hintsFilePath(sessionId); } catch { return { shown: [] }; }
  if (!existsSync(p)) return { shown: [] };
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<HintsFile>;
    if (!Array.isArray(parsed.shown)) return { shown: [] };
    return { shown: parsed.shown.filter((s) => typeof s === "string") };
  } catch {
    return { shown: [] };
  }
}

function writeHints(sessionId: string, file: HintsFile): void {
  if (!pluginDataDir() || !sessionId) return;
  let p: string;
  try { p = hintsFilePath(sessionId); } catch { return; }
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch {
    // ignore; failing to persist just means the hint may fire twice
  }
}

/** Returns true when `name` has already been shown for this session. */
export function hasHintBeenShown(sessionId: string, name: string): boolean {
  const f = readHints(sessionId);
  return f.shown.includes(name);
}

/** Idempotently records that `name` has been shown for this session. */
export function markHintShown(sessionId: string, name: string): void {
  const f = readHints(sessionId);
  if (f.shown.includes(name)) return;
  f.shown.push(name);
  writeHints(sessionId, f);
}

/** Removes the per-session hints state. Called from clearSessionState on
 *  /rooms-leave so the next session in a new room starts fresh. */
export function clearHints(sessionId: string): void {
  if (!pluginDataDir() || !sessionId) return;
  let p: string;
  try { p = hintsFilePath(sessionId); } catch { return; }
  if (existsSync(p)) {
    try { unlinkSync(p); } catch { /* ignore */ }
  }
  // Also clean up the v1.1-era marker file for backwards compatibility on
  // sessions that began under the old format.
  const legacy = join(dirname(p), `${sessionId}.hint-shown`);
  if (existsSync(legacy)) {
    try { unlinkSync(legacy); } catch { /* ignore */ }
  }
}
