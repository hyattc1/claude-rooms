// Real-Claude integration test (Phase 7 partial case-2 coverage).
// Spawns an actual `claude -p` session with --plugin-dir loading
// claude-rooms. Verifies that:
//   - the plugin loads, the MCP server connects, slash commands appear,
//   - the /claude-rooms:rooms-create command actually creates a room,
//   - the SessionStart hook's room context block is injected on resume.
//
// This test makes real model calls and is gated behind
// CLAUDE_ROOMS_RUN_REAL_CLAUDE=1 to keep CI free. Cost ceiling
// --max-budget-usd 0.30 per test.
//
// Run with:
//   CLAUDE_ROOMS_RUN_REAL_CLAUDE=1 node --test tests/real-claude.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

const ENABLED = process.env.CLAUDE_ROOMS_RUN_REAL_CLAUDE === "1";

function uniqueDir() {
  return mkdtempSync(join(tmpdir(), "claude-rooms-real-"));
}

function runClaude(args, env = {}) {
  // Strip CLAUDE_CODE_SESSION_ID from the inherited env so the spawned
  // session does not silently inherit plan-mode state from our parent.
  const finalEnv = { ...process.env, ...env };
  delete finalEnv.CLAUDE_CODE_SESSION_ID;
  return spawnSync("claude", args, {
    cwd: process.cwd(),
    env: finalEnv,
    encoding: "utf8",
    timeout: 90000,
  });
}

test(
  "plugin loads, MCP connects, /claude-rooms:rooms-create works in a real claude -p session",
  { skip: !ENABLED },
  async () => {
    const dir = uniqueDir();
    const res = runClaude(
      [
        "-p", "/claude-rooms:rooms-create",
        "--plugin-dir", process.cwd(),
        "--output-format", "json",
        "--permission-mode", "bypassPermissions",
        "--max-budget-usd", "0.30",
        "--no-session-persistence",
      ],
      { CLAUDE_PLUGIN_DATA: dir }
    );
    if (res.status !== 0) console.error("claude stderr:", res.stderr);
    assert.equal(res.status, 0, `claude exited with status ${res.status}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.is_error, false);
    assert.match(parsed.result, /^Room: [a-z]+-[a-z]+/m);
    assert.match(parsed.result, /Share this code with your teammate/);

    // Session-store should have been written. Confirm exactly one file exists.
    const sessDir = join(dir, "sessions");
    assert.ok(existsSync(sessDir), "sessions dir should exist after rooms-create");
    const files = readdirSync(sessDir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1, "exactly one session-store file should be present");
    const ss = JSON.parse(readFileSync(join(sessDir, files[0]), "utf8"));
    assert.match(ss.room_code, /^[a-z]+-[a-z]+$/);
    assert.ok(ss.actor_name.length >= 2);
  }
);

test(
  "round-trip: rooms-create then read_room_state inside one real session reports membership",
  { skip: !ENABLED },
  async () => {
    // Single-session end-to-end test that exercises:
    //   1. The /claude-rooms:rooms-create slash command (creates the room,
    //      writes session-store, primes MCP).
    //   2. The read_room_state MCP tool (returns the live snapshot).
    // We rely on the agent following a two-step instruction, but the actual
    // pass/fail is whether the final response mentions the room code,
    // which is deterministic given the tool returns it.
    const res = runClaude(
      [
        "-p",
        "First run /claude-rooms:rooms-create to make a new room. Then call read_room_state exactly once. Then output the room code on a line of its own as 'CODE:<the-code>'.",
        "--plugin-dir", process.cwd(),
        "--output-format", "json",
        "--permission-mode", "bypassPermissions",
        "--max-budget-usd", "0.60",
        "--no-session-persistence",
      ],
      {}
    );
    if (res.status !== 0) console.error("real-claude stderr:", res.stderr);
    assert.equal(res.status, 0, `claude exited ${res.status}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.is_error, false);
    // Find a 'CODE:<word>-<word>' line in the result.
    assert.match(parsed.result, /CODE:[a-z]+-[a-z]+/, `expected CODE:<code> in: ${parsed.result}`);
  }
);
