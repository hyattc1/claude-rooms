// v1.1 security additions: 4-word room codes, share_prompts default OFF,
// scrubSecrets + audit log + redactions_count, territory rate limit, and
// the one-time SessionStart privacy hint.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Y from "yjs";
import { scrubSecrets, SCRUB_MAX_INPUT_BYTES, PATTERN_NAMES } from "../dist/scrub.js";
import {
  generateRoomCode,
  isValidRoomCode,
  resolveRoomCodeLength,
  ROOM_CODE_DEFAULT_LENGTH,
} from "../dist/room-code.js";
import { WORDLIST } from "../dist/wordlist.js";
import { Room, TERRITORY_CLAIM_RATE_LIMIT_MS } from "../dist/shared-state.js";
import { sharePromptsEnabled } from "../dist/hooks/_common.js";
import { IpcClient, discoverSocketPath } from "../dist/ipc.js";

function uniqueDir() {
  return mkdtempSync(join(tmpdir(), "claude-rooms-sec-test-"));
}

function seedSession(dir, sid, room, actor) {
  const d = join(dir, "sessions");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${sid}.json`), JSON.stringify({
    room_code: room, actor_name: actor, joined_at_ms: Date.now(),
  }));
}

async function bootMcp(dataDir, extraEnv = {}) {
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  const child = spawn(process.execPath, ["./dist/mcp/server.js"], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_ROOMS_TEST_MODE: "1", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === "init") { child.stdout.off("data", onData); resolve(); }
        } catch { /* ignore */ }
      }
    };
    child.stdout.on("data", onData);
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: "init", method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "sec", version: "0" } },
    }) + "\n");
    setTimeout(() => reject(new Error("mcp init timeout")), 5000);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return child;
}

async function stopMcp(child) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } resolve(); }, 2000);
    child.on("exit", () => { clearTimeout(t); resolve(); });
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  });
}

async function ipc(dataDir) {
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  const path = discoverSocketPath({ ppid: process.pid });
  assert.ok(path);
  const c = new IpcClient(path);
  await c.connect();
  return c;
}

function runHook(name, stdin, env) {
  const res = spawnSync(process.execPath, [`./dist/hooks/${name}.js`], {
    env: { ...process.env, ...env },
    input: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    encoding: "utf8",
    timeout: 8000,
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

// ---------- Addition 1: room code length & wordlist ----------

test("EFF wordlist is bundled with >= 512 entries, all 3-5 lowercase chars, no duplicates", () => {
  assert.ok(WORDLIST.length >= 512, `wordlist too small: ${WORDLIST.length}`);
  const seen = new Set();
  for (const w of WORDLIST) {
    assert.match(w, /^[a-z]+$/, `bad entry: ${w}`);
    assert.ok(w.length >= 3 && w.length <= 5, `bad length: ${w}`);
    assert.ok(!seen.has(w), `duplicate: ${w}`);
    seen.add(w);
  }
});

test("room code length env override: 2, 4, 6, and invalid values fall back to default 4", () => {
  const prev = process.env.CLAUDE_PLUGIN_OPTION_ROOM_CODE_LENGTH;
  try {
    process.env.CLAUDE_PLUGIN_OPTION_ROOM_CODE_LENGTH = "2";
    assert.equal(resolveRoomCodeLength(), 2);
    assert.equal(generateRoomCode().split("-").length, 2);
    process.env.CLAUDE_PLUGIN_OPTION_ROOM_CODE_LENGTH = "4";
    assert.equal(resolveRoomCodeLength(), 4);
    assert.equal(generateRoomCode().split("-").length, 4);
    process.env.CLAUDE_PLUGIN_OPTION_ROOM_CODE_LENGTH = "6";
    assert.equal(resolveRoomCodeLength(), 6);
    assert.equal(generateRoomCode().split("-").length, 6);
    // Invalid / out of range -> default 4.
    process.env.CLAUDE_PLUGIN_OPTION_ROOM_CODE_LENGTH = "1";
    assert.equal(resolveRoomCodeLength(), ROOM_CODE_DEFAULT_LENGTH);
    process.env.CLAUDE_PLUGIN_OPTION_ROOM_CODE_LENGTH = "7";
    assert.equal(resolveRoomCodeLength(), ROOM_CODE_DEFAULT_LENGTH);
    process.env.CLAUDE_PLUGIN_OPTION_ROOM_CODE_LENGTH = "abc";
    assert.equal(resolveRoomCodeLength(), ROOM_CODE_DEFAULT_LENGTH);
    delete process.env.CLAUDE_PLUGIN_OPTION_ROOM_CODE_LENGTH;
    assert.equal(resolveRoomCodeLength(), ROOM_CODE_DEFAULT_LENGTH);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_OPTION_ROOM_CODE_LENGTH;
    else process.env.CLAUDE_PLUGIN_OPTION_ROOM_CODE_LENGTH = prev;
  }
});

test("isValidRoomCode accepts 2..6 segments of 3-6 chars; rejects out-of-range", () => {
  assert.ok(isValidRoomCode("kite-frog"));
  assert.ok(isValidRoomCode("kite-frog-mint-anchor"));
  assert.ok(isValidRoomCode("abc-def-ghi-jkl-mno-pqr"));
  assert.ok(!isValidRoomCode("kite"));
  assert.ok(!isValidRoomCode("k-frog"));
  assert.ok(!isValidRoomCode("a-b-c-d-e-f-g"));
  assert.ok(!isValidRoomCode("kite frog"));
});

// ---------- Addition 2: share_prompts default off ----------

test("share_prompts defaults to OFF when env var is unset", () => {
  const prev = process.env.CLAUDE_PLUGIN_OPTION_SHARE_PROMPTS;
  try {
    delete process.env.CLAUDE_PLUGIN_OPTION_SHARE_PROMPTS;
    assert.equal(sharePromptsEnabled(), false);
    process.env.CLAUDE_PLUGIN_OPTION_SHARE_PROMPTS = "false";
    assert.equal(sharePromptsEnabled(), false);
    process.env.CLAUDE_PLUGIN_OPTION_SHARE_PROMPTS = "0";
    assert.equal(sharePromptsEnabled(), false);
    process.env.CLAUDE_PLUGIN_OPTION_SHARE_PROMPTS = "true";
    assert.equal(sharePromptsEnabled(), true);
    process.env.CLAUDE_PLUGIN_OPTION_SHARE_PROMPTS = "1";
    assert.equal(sharePromptsEnabled(), true);
    process.env.CLAUDE_PLUGIN_OPTION_SHARE_PROMPTS = "on";
    assert.equal(sharePromptsEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_OPTION_SHARE_PROMPTS;
    else process.env.CLAUDE_PLUGIN_OPTION_SHARE_PROMPTS = prev;
  }
});

test("UserPromptSubmit hook with share_prompts unset stores last_prompt as null", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const sid = "sec-share-off";
    seedSession(dir, sid, "share-off-room", "connor");
    runHook("user-prompt-submit", {
      session_id: sid, hook_event_name: "UserPromptSubmit", prompt: "any prompt",
    }, { CLAUDE_PLUGIN_DATA: dir });
    await new Promise((res) => setTimeout(res, 200));
    const c = await ipc(dir);
    const got = await c.call("get_state", { session_id: sid });
    const me = got.snapshot.actors.find((a) => a.actor === "connor");
    assert.equal(me.last_prompt, null);
    c.close();
  } finally {
    await stopMcp(child);
  }
});

test("share_prompts mid-session toggle: ON then OFF clears the stored prompt", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const sid = "sec-toggle";
    seedSession(dir, sid, "toggle-room", "connor");
    // ON
    runHook("user-prompt-submit", {
      session_id: sid, hook_event_name: "UserPromptSubmit", prompt: "first message",
    }, { CLAUDE_PLUGIN_DATA: dir, CLAUDE_PLUGIN_OPTION_SHARE_PROMPTS: "true" });
    await new Promise((r) => setTimeout(r, 150));
    // OFF
    runHook("user-prompt-submit", {
      session_id: sid, hook_event_name: "UserPromptSubmit", prompt: "secret follow-up",
    }, { CLAUDE_PLUGIN_DATA: dir, CLAUDE_PLUGIN_OPTION_SHARE_PROMPTS: "false" });
    await new Promise((r) => setTimeout(r, 150));
    const c = await ipc(dir);
    const got = await c.call("get_state", { session_id: sid });
    const me = got.snapshot.actors.find((a) => a.actor === "connor");
    assert.equal(me.last_prompt, null);
    c.close();
  } finally {
    await stopMcp(child);
  }
});

test("SessionStart one-time hint fires when share_prompts is off, then suppresses", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const sid = "sec-hint";
    seedSession(dir, sid, "hint-room", "connor");
    const r1 = runHook("session-start", {
      session_id: sid, hook_event_name: "SessionStart", source: "startup", cwd: process.cwd(),
    }, { CLAUDE_PLUGIN_DATA: dir });
    assert.equal(r1.status, 0);
    const p1 = JSON.parse(r1.stdout);
    assert.match(p1.hookSpecificOutput.additionalContext, /prompt sharing is disabled by default/);

    const r2 = runHook("session-start", {
      session_id: sid, hook_event_name: "SessionStart", source: "resume", cwd: process.cwd(),
    }, { CLAUDE_PLUGIN_DATA: dir });
    assert.equal(r2.status, 0);
    const p2 = JSON.parse(r2.stdout);
    assert.doesNotMatch(p2.hookSpecificOutput.additionalContext, /prompt sharing is disabled by default/);
  } finally {
    await stopMcp(child);
  }
});

test("/rooms-status surfaces the prompt-sharing-disabled line when share_prompts is off", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const sid = "sec-status";
    seedSession(dir, sid, "status-room", "connor");
    const res = spawnSync(process.execPath, ["./dist/commands/rooms-status.js"], {
      env: {
        ...process.env, CLAUDE_PLUGIN_DATA: dir, CLAUDE_CODE_SESSION_ID: sid,
      },
      encoding: "utf8", timeout: 8000,
    });
    // Should NOT have CLAUDE_PLUGIN_OPTION_SHARE_PROMPTS set; default is off.
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /prompt sharing disabled by default/);
  } finally {
    await stopMcp(child);
  }
});

// ---------- Addition 3: scrubSecrets ----------

test("scrubSecrets: Anthropic API key (sk-ant-) is redacted exactly once", () => {
  const r = scrubSecrets("debugging issue with sk-ant-AAAABBBBCCCCDDDDEEEEFFFF1234");
  assert.match(r.scrubbed, /debugging issue with \[redacted\]/);
  assert.equal(r.redactedCount, 1);
  assert.equal(r.redactionsByPattern["anthropic-api-key"], 1);
});

test("scrubSecrets: OpenAI / generic sk- key is redacted once", () => {
  const r = scrubSecrets("OPENAI_API_KEY=sk-AAAABBBBCCCCDDDDEEEEFFFF1234");
  assert.match(r.scrubbed, /\[redacted\]/);
  assert.equal(r.redactedCount, 1);
  assert.equal(r.redactionsByPattern["openai-or-generic-sk"], 1);
});

test("scrubSecrets: pattern ordering avoids double-counting on overlapping prefixes", () => {
  const text = "sk-ant-AAAABBBBCCCCDDDDEEEEFFFF1234 and sk-XXXXYYYYZZZZAAAABBBBCCCC1234";
  const r = scrubSecrets(text);
  assert.equal(r.redactedCount, 2);
  assert.equal(r.redactionsByPattern["anthropic-api-key"], 1);
  assert.equal(r.redactionsByPattern["openai-or-generic-sk"], 1);
  // Both redacted, no overlap.
  assert.match(r.scrubbed, /\[redacted\] and \[redacted\]/);
});

test("scrubSecrets: GitHub PAT variants all redact", () => {
  const ghp = "ghp_" + "A".repeat(36);
  const gho = "gho_" + "B".repeat(36);
  const ghs = "ghs_" + "C".repeat(36);
  const gpat = "github_pat_" + "x".repeat(20);
  const r = scrubSecrets([ghp, gho, ghs, gpat].join(" "));
  assert.equal(r.redactedCount, 4);
});

test("scrubSecrets: AWS access key id is redacted", () => {
  const r = scrubSecrets("user uploaded with AKIAABCDEFGHIJKLMNOP last week");
  assert.equal(r.redactedCount, 1);
  assert.match(r.scrubbed, /\[redacted\]/);
});

test("scrubSecrets: Slack tokens redact", () => {
  const r = scrubSecrets("xoxb-12345-67890-abcdefghij and xoxp-98765-43210-zyxwvuts");
  assert.equal(r.redactedCount, 2);
});

test("scrubSecrets: three-segment JWT redacts", () => {
  const jwt = "eyJabcdefghij.eyJ0fghijklmn.signature1234";
  const r = scrubSecrets(`Authorization: Bearer ${jwt}`);
  assert.equal(r.redactedCount, 1);
  assert.match(r.scrubbed, /\[redacted\]/);
});

test("scrubSecrets: PEM private key block redacts", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
  const r = scrubSecrets(`Stored: ${pem} (end)`);
  assert.equal(r.redactedCount, 1);
  assert.match(r.scrubbed, /Stored: \[redacted\] \(end\)/);
});

test("scrubSecrets: URL-embedded credentials redact only the password segment", () => {
  const r = scrubSecrets("connecting to https://alice:pa55word123@host.example.com/path?q=1 now");
  assert.equal(r.redactedCount, 1);
  assert.match(r.scrubbed, /https:\/\/alice:\[redacted\]@host\.example\.com\/path\?q=1/);
});

test("scrubSecrets: URL-cred regex does not match non-URL ':X@' shapes", () => {
  // Looks superficially similar but no protocol prefix.
  const r = scrubSecrets("failed to connect to db:weakpass@server after 30s");
  assert.equal(r.redactedCount, 0);
});

test("scrubSecrets: false-positive set produces zero redactions", () => {
  const lines = [
    "Update README.md and bump version 1.2.3-rc.4",
    "@scoped/package-name@2.0.1 installed",
    "uuid: 550e8400-e29b-41d4-a716-446655440000",
    "blob hash f0d3a2c7b8e9f1234567890abcdef1234567890",
    "data:image/png;base64," + "A".repeat(800),
    "src/lib/auth-helpers/index.ts changed",
    "the quick brown fox jumps over the lazy dog several times",
  ];
  for (const text of lines) {
    const r = scrubSecrets(text);
    assert.equal(r.redactedCount, 0, `false positive on: ${text}`);
  }
});

test("scrubSecrets: mixed content with three distinct secrets redacts all of them in one pass", () => {
  const text =
    "Found sk-ant-AAAABBBBCCCCDDDDEEEEFFFF1234 in env, github_pat_xxxxxxxxxxxxxxxxxxxx in code, " +
    "and url https://u:passwordabc@example.com/x. End.";
  const r = scrubSecrets(text);
  assert.equal(r.redactedCount, 3);
  assert.match(r.scrubbed, /\[redacted\]/);
  assert.match(r.scrubbed, /u:\[redacted\]@example\.com/);
});

test("scrubSecrets: oversized input is capped at SCRUB_MAX_INPUT_BYTES with truncation marker", () => {
  const big = "x".repeat(1024 * 1024); // 1MB
  const start = Date.now();
  const r = scrubSecrets(big);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `scrub took too long: ${elapsed}ms`);
  assert.ok(r.scrubbed.includes("[truncated-by-claude-rooms]"));
  assert.equal(r.redactedCount, 0);
  assert.ok(r.scrubbed.length <= SCRUB_MAX_INPUT_BYTES + 64);
});

test("PATTERN_NAMES contains the expected pattern set in deterministic order", () => {
  assert.ok(PATTERN_NAMES.includes("pem-private-key"));
  assert.ok(PATTERN_NAMES.includes("anthropic-api-key"));
  assert.ok(PATTERN_NAMES.includes("openai-or-generic-sk"));
  // Specific-before-generic invariant: anthropic must precede generic sk-.
  const antIdx = PATTERN_NAMES.indexOf("anthropic-api-key");
  const skIdx = PATTERN_NAMES.indexOf("openai-or-generic-sk");
  assert.ok(antIdx < skIdx, "anthropic must run before openai-or-generic-sk");
});

// ---------- Atomic redactions_count + audit log ----------

test("Room: secret in focus increments redactions_count atomically", () => {
  const ydoc = new Y.Doc();
  const A = new Room("sec-room", "connor", { ydoc });
  A.connect({ testMode: true });
  A.setMyState({ focus: "debugging sk-ant-AAAABBBBCCCCDDDDEEEEFFFF1234 issue" });
  A.flushMyState();
  const me = A.getSnapshot().actors.find((a) => a.actor === "connor");
  assert.match(me.focus, /\[redacted\]/);
  assert.equal(me.redactions_count, 1);

  // Two more secrets in two more updates -> counter accumulates.
  A.updatePlan({ summary: "fix sk-XXXXYYYYZZZZAAAABBBBCCCCDDD bug", steps_total: 3, steps_done: 0 });
  A.claimTerritory(["src/api/users.*"], "secret ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA in purpose");
  const snap = A.getSnapshot();
  const me2 = snap.actors.find((a) => a.actor === "connor");
  assert.equal(me2.redactions_count, 3);
});

test("Audit log written to ${CLAUDE_PLUGIN_DATA}/redactions-<sid>.log with no matched text", () => {
  const dir = uniqueDir();
  const sid = "sec-audit";
  const ydoc = new Y.Doc();
  const A = new Room("audit-room", "connor", { ydoc, sessionId: sid, dataDir: dir });
  A.connect({ testMode: true });
  const secret = "sk-ant-AAAABBBBCCCCDDDDEEEEFFFF1234";
  A.setMyState({ focus: `debug ${secret} now` });
  A.flushMyState();
  const logPath = join(dir, `redactions-${sid}.log`);
  assert.ok(existsSync(logPath), "audit log file should exist");
  const content = readFileSync(logPath, "utf8");
  // Must NOT contain the matched secret text.
  assert.ok(!content.includes(secret), "audit log must not contain the matched text");
  // Must contain the pattern name + redacted_count.
  assert.match(content, /"anthropic-api-key":/);
  assert.match(content, /"redacted_count":1/);
  assert.match(content, /"field":"focus"/);
});

test("redactions_count surfaces in /rooms-status when nonzero", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const sid = "sec-stat-red";
    seedSession(dir, sid, "stat-red-room", "connor");
    const c = await ipc(dir);
    await c.call("set_my_state", {
      session_id: sid,
      patch: { focus: "debug sk-ant-AAAABBBBCCCCDDDDEEEEFFFF1234 issue" },
    });
    await new Promise((r) => setTimeout(r, 400));
    c.close();

    const res = spawnSync(process.execPath, ["./dist/commands/rooms-status.js"], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, CLAUDE_CODE_SESSION_ID: sid },
      encoding: "utf8", timeout: 8000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /1 likely secret auto-redacted from your shared state this session/);
  } finally {
    await stopMcp(child);
  }
});

// ---------- Territory rate limit ----------

test("claim_territory rate-limits to one per 30s per actor", () => {
  const ydoc = new Y.Doc();
  const A = new Room("rate-room", "connor", { ydoc });
  A.connect({ testMode: true });
  const first = A.claimTerritory(["src/auth/**"], "first claim");
  assert.equal(first.claimed, true);
  // Immediate second call should be rate-limited.
  const second = A.claimTerritory(["src/api/**"], "second claim");
  assert.equal(second.claimed, false);
  assert.equal(second.reason, "rate-limited");
  assert.ok(typeof second.retry_after_ms === "number");
  assert.ok(second.retry_after_ms <= TERRITORY_CLAIM_RATE_LIMIT_MS);
  // The existing claim is unchanged.
  const me = A.getSnapshot().actors.find((a) => a.actor === "connor");
  assert.deepEqual(me.territory.globs, ["src/auth/**"]);
  assert.equal(me.territory.purpose, "first claim");
});
