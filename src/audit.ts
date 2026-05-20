// Local-only audit log for credential redactions. Append-only, capped at
// AUDIT_LOG_MAX_BYTES by truncate-on-overflow (newest content wins).
//
// Format: one JSON line per redaction batch. Example:
//   {"ts_ms": 1779269000000, "field": "focus", "pattern": "anthropic-api-key",
//    "input_len": 73, "redacted_count": 1}
//
// Critical invariant: the matched text is NEVER written. Only pattern names
// and small metadata (timestamps, field name, input length).

import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const AUDIT_LOG_MAX_BYTES = 1 * 1024 * 1024; // 1MB

function logPath(dataDir: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_.\-]+$/.test(sessionId)) {
    throw new Error(`audit: invalid session id`);
  }
  return join(dataDir, `redactions-${sessionId}.log`);
}

export interface AuditEntry {
  field: string;
  patterns: Record<string, number>;
  input_len: number;
  redacted_count: number;
}

/** Append one or more entries to the per-session audit log. Best-effort:
 *  any I/O error is swallowed (the audit log is human-debugging, not load-bearing). */
export function appendAuditEntries(
  dataDir: string,
  sessionId: string,
  entries: AuditEntry[]
): void {
  if (!dataDir || !sessionId || entries.length === 0) return;
  let p: string;
  try {
    p = logPath(dataDir, sessionId);
  } catch {
    return;
  }
  try {
    mkdirSync(dirname(p), { recursive: true });
  } catch { /* ignore */ }
  const now = Date.now();
  const lines = entries.map((e) =>
    JSON.stringify({
      ts_ms: now,
      field: e.field,
      patterns: e.patterns,
      input_len: e.input_len,
      redacted_count: e.redacted_count,
    })
  ).join("\n") + "\n";
  try {
    // Truncate-on-overflow: if the existing log is at the cap, replace it
    // with the new lines so we always keep the most recent activity.
    if (existsSync(p)) {
      const size = statSync(p).size;
      if (size + lines.length > AUDIT_LOG_MAX_BYTES) {
        const trimmed = readFileSync(p, "utf8").split("\n");
        // Keep the last ~half of the file plus the new lines.
        const keep = trimmed.slice(Math.floor(trimmed.length / 2)).join("\n");
        writeFileSync(p, keep + lines, { encoding: "utf8", mode: 0o600 });
        return;
      }
    }
    appendFileSync(p, lines, { encoding: "utf8", mode: 0o600 });
  } catch {
    // ignore
  }
}

/** Convenience for one entry. */
export function appendAuditEntry(
  dataDir: string,
  sessionId: string,
  entry: AuditEntry
): void {
  appendAuditEntries(dataDir, sessionId, [entry]);
}
