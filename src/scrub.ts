// Best-effort secret scrubbing. Runs on the writer side (the Room boundary in
// src/shared-state.ts), so a redacted string never enters the Y.Doc. This
// protects users who paste API keys, tokens, or private keys into prompts,
// commit messages, focus strings, plan summaries, or territory purposes.
//
// Design constraints:
//   - Pure, synchronous, no I/O. Audit logging is done by the caller.
//   - Pattern-based, no entropy heuristics (those are v2).
//   - Specific patterns run before generic ones; generic patterns use
//     negative lookahead to avoid double-matching what specific patterns
//     already redacted.
//   - Every pattern has a minimum-length floor (and an upper bound where
//     applicable) to limit false positives and defang ReDoS.
//   - Input length is hard-capped at SCRUB_MAX_INPUT_BYTES (8KB). Pathological
//     inputs are truncated with a visible marker before regex engine work.

export interface ScrubResult {
  scrubbed: string;
  redactedCount: number;
  /** Per-pattern hit counts, for the audit log. Pattern name -> hits. */
  redactionsByPattern: Record<string, number>;
}

export const SCRUB_MAX_INPUT_BYTES = 8 * 1024;
const TRUNCATION_MARKER = "[truncated-by-claude-rooms]";
const REDACTED = "[redacted]";

interface PatternSpec {
  name: string;
  regex: RegExp;
  /** Optional callback. If provided, runs `text.replace(regex, callback)`.
   *  Each call should return the replacement and increment hits via the
   *  closure variable. If absent, the constant `[redacted]` is used. */
  callback?: (counter: { n: number }) => (match: string, ...groups: string[]) => string;
}

// Pattern table. Order matters: specific BEFORE generic.
const PATTERNS: readonly PatternSpec[] = Object.freeze([
  // 1. PEM private keys. Multiline with explicit upper bound so a runaway
  //    document never burns CPU on the non-greedy match.
  {
    name: "pem-private-key",
    regex: /-----BEGIN[ A-Z]+PRIVATE KEY-----[\s\S]{1,4096}?-----END[ A-Z]+PRIVATE KEY-----/g,
  },
  // 2. JSON Web Tokens. Three base64url segments separated by dots, each at
  //    least 10 chars to avoid eating short test JWTs and short base64 blobs.
  {
    name: "jwt",
    regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  // 3. Anthropic API keys (specific).
  {
    name: "anthropic-api-key",
    regex: /sk-ant-[A-Za-z0-9_-]{20,}/g,
  },
  // 4. Generic OpenAI / sk- keys. Negative lookahead rules out sk-ant- so we
  //    do not double-count when both patterns could fire on the same text.
  {
    name: "openai-or-generic-sk",
    regex: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/g,
  },
  // 5. GitHub tokens.
  { name: "github-pat-classic", regex: /ghp_[A-Za-z0-9]{36,}/g },
  { name: "github-oauth",       regex: /gho_[A-Za-z0-9]{36,}/g },
  { name: "github-server",      regex: /ghs_[A-Za-z0-9]{36,}/g },
  { name: "github-pat-fine",    regex: /github_pat_[A-Za-z0-9_]{20,}/g },
  // 6. AWS access key IDs.
  { name: "aws-access-key-id", regex: /AKIA[A-Z0-9]{16}/g },
  // 7. Slack tokens.
  { name: "slack-bot",  regex: /xoxb-[A-Za-z0-9-]+/g },
  { name: "slack-user", regex: /xoxp-[A-Za-z0-9-]+/g },
  // 8. URL-embedded credentials. Anchored to a recognized protocol so we do
  //    not match generic "X:Y@" in log lines. Replacement keeps the URL
  //    structure intact and only blanks the password segment.
  {
    name: "url-embedded-credentials",
    regex: /\b(https?|ftp|ssh|git):\/\/([A-Za-z0-9._~-]+):([^@\s/]{4,})@/g,
    callback: (counter) => (_m, scheme: string, user: string) => {
      counter.n += 1;
      return `${scheme}://${user}:${REDACTED}@`;
    },
  },
]);

function applyOne(text: string, spec: PatternSpec, byPattern: Record<string, number>): string {
  let hits = 0;
  if (spec.callback) {
    const counter = { n: 0 };
    const fn = spec.callback(counter);
    const out = text.replace(spec.regex, fn);
    hits = counter.n;
    if (hits > 0) byPattern[spec.name] = (byPattern[spec.name] ?? 0) + hits;
    return out;
  }
  const out = text.replace(spec.regex, () => {
    hits += 1;
    return REDACTED;
  });
  if (hits > 0) byPattern[spec.name] = (byPattern[spec.name] ?? 0) + hits;
  return out;
}

/** Run the credential patterns over `text` and return the scrubbed result
 *  plus a count. Inputs over SCRUB_MAX_INPUT_BYTES are truncated first to
 *  cap regex-engine work; the truncation marker is appended so the user
 *  can tell that scrubbing happened on a truncated input. */
export function scrubSecrets(text: string | null | undefined): ScrubResult {
  if (text == null || text === "") {
    return { scrubbed: "", redactedCount: 0, redactionsByPattern: {} };
  }
  let input = text;
  if (input.length > SCRUB_MAX_INPUT_BYTES) {
    input = input.slice(0, SCRUB_MAX_INPUT_BYTES) + TRUNCATION_MARKER;
  }
  const byPattern: Record<string, number> = {};
  let cur = input;
  for (const spec of PATTERNS) {
    cur = applyOne(cur, spec, byPattern);
  }
  const redactedCount = Object.values(byPattern).reduce((a, b) => a + b, 0);
  return { scrubbed: cur, redactedCount, redactionsByPattern: byPattern };
}

/** Convenience: scrub a value that may be undefined / null / non-string,
 *  preserving the original shape. Returns [maybeScrubbed, count]. */
export function scrubMaybe<T>(value: T): { value: T; redactedCount: number; redactionsByPattern: Record<string, number> } {
  if (typeof value !== "string") {
    return { value, redactedCount: 0, redactionsByPattern: {} };
  }
  const r = scrubSecrets(value as string);
  return {
    value: r.scrubbed as unknown as T,
    redactedCount: r.redactedCount,
    redactionsByPattern: r.redactionsByPattern,
  };
}

/** For tests / introspection. */
export const PATTERN_NAMES: readonly string[] = Object.freeze(PATTERNS.map((p) => p.name));
