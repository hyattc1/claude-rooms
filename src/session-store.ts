import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// Per-session room membership, keyed on the Claude Code session id.
// Slash commands write this file; hooks and the MCP server read it to decide
// whether this session is currently in a room.

export interface SessionState {
  room_code: string;
  actor_name: string;
  joined_at_ms: number;
}

function dataDir(): string {
  // Prefer the harness-provided CLAUDE_PLUGIN_DATA; fall back to a stable per-user path
  // so this module also works in unit tests outside Claude Code.
  const env = process.env.CLAUDE_PLUGIN_DATA;
  if (env) return env;
  return join(homedir(), ".claude", "plugins", "data", "claude-rooms-fallback");
}

function sessionsDir(): string {
  return join(dataDir(), "sessions");
}

export function sessionFilePath(sessionId: string): string {
  if (!/^[A-Za-z0-9_.\-]+$/.test(sessionId)) {
    throw new Error(`invalid session id: ${sessionId}`);
  }
  return join(sessionsDir(), `${sessionId}.json`);
}

export function readSessionState(sessionId: string): SessionState | null {
  const p = sessionFilePath(sessionId);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    if (typeof parsed.room_code !== "string" || typeof parsed.actor_name !== "string") return null;
    return {
      room_code: parsed.room_code,
      actor_name: parsed.actor_name,
      joined_at_ms: typeof parsed.joined_at_ms === "number" ? parsed.joined_at_ms : Date.now(),
    };
  } catch {
    return null;
  }
}

export function writeSessionState(sessionId: string, state: SessionState): void {
  const p = sessionFilePath(sessionId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function clearSessionState(sessionId: string): void {
  const p = sessionFilePath(sessionId);
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      // ignore
    }
  }
  // v1.1: also clear the SessionStart one-time-hint marker so the next
  // session in a new room starts fresh.
  const hintMarker = join(sessionsDir(), `${sessionId}.hint-shown`);
  if (existsSync(hintMarker)) {
    try { unlinkSync(hintMarker); } catch { /* ignore */ }
  }
}
