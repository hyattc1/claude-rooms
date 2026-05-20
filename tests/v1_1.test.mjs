// v1.1 feature tests: git state, plan mode, last_prompt, territory.
// Most tests use CLAUDE_ROOMS_TEST_MODE=1 so two sessions in the same MCP
// process share a Y.Doc and exercise the cross-actor behaviour without
// real WebRTC.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IpcClient, discoverSocketPath } from "../dist/ipc.js";
import { Room, DEFAULT_TERRITORY_TTL_MS } from "../dist/shared-state.js";
import { matchAny, findOverlaps } from "../dist/territory.js";
import * as Y from "yjs";

function uniqueDir() {
  return mkdtempSync(join(tmpdir(), "claude-rooms-v11-test-"));
}

function seedSession(dir, sid, room, actor) {
  const d = join(dir, "sessions");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${sid}.json`), JSON.stringify({
    room_code: room, actor_name: actor, joined_at_ms: Date.now(),
  }));
}

async function bootMcp(dataDir) {
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  const child = spawn(process.execPath, ["./dist/mcp/server.js"], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_ROOMS_TEST_MODE: "1" },
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
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "v11", version: "0" } },
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

// ---- 1. minimatch / territory unit tests (no MCP) ----

test("matchAny matches gitignore-style globs against POSIX paths", () => {
  assert.equal(matchAny("src/auth/jwt.ts", ["src/auth/**"]), true);
  assert.equal(matchAny("src/api/users.ts", ["src/api/users.*"]), true);
  assert.equal(matchAny("tests/auth.test.ts", ["src/auth/**"]), false);
  assert.equal(matchAny("docs/index.md", ["docs/**"]), true);
  assert.equal(matchAny("a/b/c.ts", ["a/**", "b/**"]), true);
});

test("findOverlaps returns the matching teammates and purposes", () => {
  const hits = findOverlaps(
    ["src/api/users.ts", "tests/auth.test.ts"],
    [
      { actor: "ryan", territory: { globs: ["src/api/**"], purpose: "users endpoint", claimed_at_ms: 0, ttl_ms: 1e9 } },
      { actor: "alex", territory: { globs: ["tests/**"], purpose: "test coverage", claimed_at_ms: 0, ttl_ms: 1e9 } },
      { actor: "missing", territory: null },
    ]
  );
  assert.equal(hits.length, 2);
  const byFile = Object.fromEntries(hits.map((h) => [h.file, h]));
  assert.equal(byFile["src/api/users.ts"].teammate, "ryan");
  assert.equal(byFile["tests/auth.test.ts"].teammate, "alex");
});

// ---- 2. shared-state Room: claim / release / TTL ----

test("Room.claimTerritory and releaseTerritory roundtrip via snapshot.actors[].territory", () => {
  const A = new Room("v11-room", "connor", { ydoc: new Y.Doc() });
  A.connect({ testMode: true });
  A.claimTerritory(["src/auth/**"], "auth refactor");
  let snap = A.getSnapshot();
  let me = snap.actors.find((a) => a.actor === "connor");
  assert.ok(me.territory);
  assert.deepEqual(me.territory.globs, ["src/auth/**"]);
  assert.equal(me.territory.purpose, "auth refactor");

  A.releaseTerritory();
  snap = A.getSnapshot();
  me = snap.actors.find((a) => a.actor === "connor");
  assert.equal(me.territory ?? null, null);
});

test("Territory TTL filters expired claims out of the snapshot view", async () => {
  const A = new Room("v11-room", "connor", { ydoc: new Y.Doc() });
  A.connect({ testMode: true });
  A.claimTerritory(["src/x/**"], "tmp", 30);
  await new Promise((r) => setTimeout(r, 60));
  const snap = A.getSnapshot();
  const me = snap.actors.find((a) => a.actor === "connor");
  assert.equal(me.territory ?? null, null, "expired territory should be hidden");
});

test("cross-version: a v1.0-shaped actor record renders gracefully via the v1.1 snapshot", () => {
  // Simulate a v1.0 peer by writing only the v1 fields directly into the Y.Doc.
  const doc = new Y.Doc();
  const A = new Room("xv-room", "connor", { ydoc: doc });
  A.connect({ testMode: true });
  // Manually inject a "v1-only" actor entry for ryan.
  doc.transact(() => {
    doc.getMap("actors").set("ryan", {
      actor: "ryan",
      focus: "writing tests",
      branch: "main",
      files_open: [],
      last_action: null,
      recent_actions: [],
      blockers: [],
      online: true,
      last_heartbeat_ms: Date.now(),
    });
  });
  const snap = A.getSnapshot();
  const ryan = snap.actors.find((a) => a.actor === "ryan");
  assert.ok(ryan);
  // v1.1 reader should see the v1 fields and not crash on missing optional ones.
  assert.equal(ryan.focus, "writing tests");
  assert.equal(ryan.git ?? null, null);
  assert.equal(ryan.plan ?? null, null);
  assert.equal(ryan.last_prompt ?? null, null);
  assert.equal(ryan.territory ?? null, null);
});

test("Room.getSnapshot exposes schema_version=2 and territory_overlap array", () => {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  // share a doc
  const A = new Room("ov-room", "connor", { ydoc: docA });
  const B = new Room("ov-room", "ryan", { ydoc: docA });
  A.connect({ testMode: true });
  B.connect({ testMode: true });

  B.claimTerritory(["src/api/users.*"], "users endpoint");
  A.setMyState({ files_open: ["src/api/users.ts"] });
  A.flushMyState();

  const snap = A.getSnapshot();
  assert.equal(snap.schema_version, 2);
  assert.ok(Array.isArray(snap.territory_overlap));
  assert.equal(snap.territory_overlap.length, 1);
  assert.equal(snap.territory_overlap[0].teammate, "ryan");
  assert.equal(snap.territory_overlap[0].file, "src/api/users.ts");
});

// ---- 3. IPC + MCP: end-to-end roundtrips ----

test("IPC update_my_plan + get_state surfaces plan in actor view", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const sid = "v11-plan";
    seedSession(dir, sid, "plan-room", "connor");
    const c = await ipc(dir);
    await c.call("update_my_plan", {
      session_id: sid,
      summary: "add users endpoint with pagination",
      steps_total: 5,
      steps_done: 2,
    });
    const got = await c.call("get_state", { session_id: sid });
    const me = got.snapshot.actors.find((a) => a.actor === "connor");
    assert.ok(me.plan);
    assert.equal(me.plan.summary, "add users endpoint with pagination");
    assert.equal(me.plan.steps_total, 5);
    assert.equal(me.plan.steps_done, 2);
    c.close();
  } finally {
    await stopMcp(child);
  }
});

test("IPC update_my_git: commits cached when head unchanged on light refresh", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const sid = "v11-git";
    seedSession(dir, sid, "git-room", "connor");
    const c = await ipc(dir);
    await c.call("update_my_git", {
      session_id: sid,
      state: { repo: "demo", branch: "main", head: "abcdef0", dirty: false, recent_commits: ["init", "wip"] },
      include_commits: true,
    });
    // Light refresh with same head: commits should be preserved.
    await c.call("update_my_git", {
      session_id: sid,
      state: { repo: "demo", branch: "main", head: "abcdef0", dirty: true, recent_commits: [] },
      include_commits: false,
    });
    const got = await c.call("get_state", { session_id: sid });
    const me = got.snapshot.actors.find((a) => a.actor === "connor");
    assert.deepEqual(me.git.recent_commits, ["init", "wip"]);
    assert.equal(me.git.dirty, true);
    c.close();
  } finally {
    await stopMcp(child);
  }
});

test("IPC set_last_prompt stores truncated text; null clears it", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const sid = "v11-prompt";
    seedSession(dir, sid, "prompt-room", "connor");
    const c = await ipc(dir);
    await c.call("set_last_prompt", { session_id: sid, text: "add /users endpoint with pagination and JWT auth" });
    let got = await c.call("get_state", { session_id: sid });
    let me = got.snapshot.actors.find((a) => a.actor === "connor");
    assert.match(me.last_prompt.text, /add \/users endpoint/);

    await c.call("set_last_prompt", { session_id: sid, text: null });
    got = await c.call("get_state", { session_id: sid });
    me = got.snapshot.actors.find((a) => a.actor === "connor");
    assert.equal(me.last_prompt, null);
    c.close();
  } finally {
    await stopMcp(child);
  }
});

test("IPC claim_territory + release_territory roundtrip across two sessions", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const sidA = "v11-tA";
    const sidB = "v11-tB";
    seedSession(dir, sidA, "t-room", "alice");
    seedSession(dir, sidB, "t-room", "bob");
    const c = await ipc(dir);

    await c.call("claim_territory", {
      session_id: sidA,
      globs: ["src/auth/**", "src/middleware/auth.ts"],
      purpose: "auth refactor",
    });

    let snap = (await c.call("get_state", { session_id: sidB })).snapshot;
    const alice = snap.actors.find((a) => a.actor === "alice");
    assert.ok(alice.territory);
    assert.deepEqual(alice.territory.globs, ["src/auth/**", "src/middleware/auth.ts"]);

    await c.call("release_territory", { session_id: sidA });
    snap = (await c.call("get_state", { session_id: sidB })).snapshot;
    const aliceAfter = snap.actors.find((a) => a.actor === "alice");
    assert.equal(aliceAfter.territory ?? null, null);
    c.close();
  } finally {
    await stopMcp(child);
  }
});

test("IPC check_territory_overlap returns hits across actors in the same room", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const sidA = "v11-ovA";
    const sidB = "v11-ovB";
    seedSession(dir, sidA, "ov-room", "alice");
    seedSession(dir, sidB, "ov-room", "bob");
    const c = await ipc(dir);
    await c.call("claim_territory", {
      session_id: sidA,
      globs: ["src/api/users.*"],
      purpose: "add /users endpoint with pagination",
    });
    const r = await c.call("check_territory_overlap", {
      session_id: sidB,
      files: ["src/api/users.ts", "src/unrelated.ts"],
    });
    assert.equal(r.overlaps.length, 1);
    assert.equal(r.overlaps[0].file, "src/api/users.ts");
    assert.equal(r.overlaps[0].teammate, "alice");
    c.close();
  } finally {
    await stopMcp(child);
  }
});

// ---- 4. PreToolUse hook overlap and lock interaction ----

function runHook(name, stdin, env) {
  const res = spawnSync(process.execPath, [`./dist/hooks/${name}.js`], {
    env: { ...process.env, ...env },
    input: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    encoding: "utf8",
    timeout: 8000,
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

test("PreToolUse allow path includes a territory-overlap note when applicable", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const meSid = "v11-meSid";
    const otherSid = "v11-otherSid";
    seedSession(dir, meSid, "soft-room", "connor");
    seedSession(dir, otherSid, "soft-room", "ryan");
    const c = await ipc(dir);
    await c.call("claim_territory", {
      session_id: otherSid,
      globs: ["/tmp/api/users.*"],
      purpose: "add users endpoint",
    });
    c.close();
    const r = runHook("pre-edit", {
      session_id: meSid,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/api/users.ts", old_string: "a", new_string: "b" },
      cwd: process.cwd(),
    }, { CLAUDE_PLUGIN_DATA: dir });
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout);
    assert.notEqual(payload.hookSpecificOutput.permissionDecision, "deny");
    assert.match(payload.hookSpecificOutput.additionalContext, /ryan's claimed territory/);
    assert.match(payload.hookSpecificOutput.additionalContext, /add users endpoint/);
  } finally {
    await stopMcp(child);
  }
});

test("PreToolUse lock-deny still wins over territory overlap", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const meSid = "v11-meSid2";
    const otherSid = "v11-otherSid2";
    seedSession(dir, meSid, "soft-lock-room", "connor");
    seedSession(dir, otherSid, "soft-lock-room", "ryan");
    const c = await ipc(dir);
    await c.call("claim_territory", {
      session_id: otherSid,
      globs: ["/tmp/shared/*"],
      purpose: "shared work",
    });
    await c.call("try_acquire_locks", { session_id: otherSid, files: ["/tmp/shared/file.ts"] });
    c.close();
    const r = runHook("pre-edit", {
      session_id: meSid,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/shared/file.ts", old_string: "a", new_string: "b" },
      cwd: process.cwd(),
    }, { CLAUDE_PLUGIN_DATA: dir });
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.hookSpecificOutput.permissionDecision, "deny");
    assert.match(payload.hookSpecificOutput.permissionDecisionReason, /currently held by ryan/);
  } finally {
    await stopMcp(child);
  }
});

// ---- 5. UserPromptSubmit hook ----

test("user-prompt-submit truncates long prompts to 100 chars + ellipsis (with share_prompts explicitly on)", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const sid = "v11-ups";
    seedSession(dir, sid, "ups-room", "connor");
    const long = "x".repeat(300);
    // share_prompts now defaults OFF in v1.1; explicitly opt in for this test.
    const r = runHook("user-prompt-submit", {
      session_id: sid,
      hook_event_name: "UserPromptSubmit",
      prompt: long,
    }, { CLAUDE_PLUGIN_DATA: dir, CLAUDE_PLUGIN_OPTION_SHARE_PROMPTS: "true" });
    assert.equal(r.status, 0);
    await new Promise((res) => setTimeout(res, 200));
    const c = await ipc(dir);
    const got = await c.call("get_state", { session_id: sid });
    const me = got.snapshot.actors.find((a) => a.actor === "connor");
    assert.ok(me.last_prompt);
    assert.equal(me.last_prompt.text.length, 100);
    assert.ok(me.last_prompt.text.endsWith("..."));
    c.close();
  } finally {
    await stopMcp(child);
  }
});

test("user-prompt-submit with share_prompts=false clears last_prompt to null", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const sid = "v11-ups-off";
    seedSession(dir, sid, "ups-off-room", "connor");
    // First, set a prompt with share-on, then clear it via share-off.
    runHook("user-prompt-submit", {
      session_id: sid,
      hook_event_name: "UserPromptSubmit",
      prompt: "first message visible to room",
    }, { CLAUDE_PLUGIN_DATA: dir });
    await new Promise((r) => setTimeout(r, 150));
    const r = runHook("user-prompt-submit", {
      session_id: sid,
      hook_event_name: "UserPromptSubmit",
      prompt: "secret message that should not propagate",
    }, { CLAUDE_PLUGIN_DATA: dir, CLAUDE_PLUGIN_OPTION_SHARE_PROMPTS: "false" });
    assert.equal(r.status, 0);
    await new Promise((res) => setTimeout(res, 150));
    const c = await ipc(dir);
    const got = await c.call("get_state", { session_id: sid });
    const me = got.snapshot.actors.find((a) => a.actor === "connor");
    assert.equal(me.last_prompt, null);
    c.close();
  } finally {
    await stopMcp(child);
  }
});

// ---- 6. PostToolUse publishes git light and plan in_plan_mode ----

test("post-edit publishes a light git refresh and the plan in_plan_mode flag", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const sid = "v11-post";
    seedSession(dir, sid, "post-room", "connor");
    runHook("post-edit", {
      session_id: sid,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/poo.ts", old_string: "a", new_string: "b" },
      cwd: process.cwd(),
      permission_mode: "plan",
    }, { CLAUDE_PLUGIN_DATA: dir });
    await new Promise((res) => setTimeout(res, 400));
    const c = await ipc(dir);
    const got = await c.call("get_state", { session_id: sid });
    const me = got.snapshot.actors.find((a) => a.actor === "connor");
    // plan should be initialized with in_plan_mode true
    assert.ok(me.plan);
    assert.equal(me.plan.in_plan_mode, true);
    // git may be null if cwd is not a repo, but the field key should exist.
    assert.ok(Object.prototype.hasOwnProperty.call(me, "git"));
    c.close();
  } finally {
    await stopMcp(child);
  }
});

// ---- 7. /rooms-status formatter integration ----

test("rooms-status output includes git, plan, territory, and last_prompt blocks for teammates", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const meSid = "v11-rsMe";
    const otherSid = "v11-rsOther";
    seedSession(dir, meSid, "rs-room", "connor");
    seedSession(dir, otherSid, "rs-room", "ryan");
    const c = await ipc(dir);
    await c.call("update_my_git", {
      session_id: otherSid,
      state: { repo: "demo", branch: "feat/users", head: "abc1234", dirty: false, recent_commits: ["init"] },
      include_commits: true,
    });
    await c.call("update_my_plan", {
      session_id: otherSid,
      summary: "add /users endpoint with pagination",
      steps_total: 5,
      steps_done: 2,
    });
    await c.call("set_last_prompt", {
      session_id: otherSid,
      text: "add a /users endpoint with pagination",
    });
    await c.call("claim_territory", {
      session_id: otherSid,
      globs: ["src/api/users.*"],
      purpose: "users endpoint",
    });
    c.close();

    const res = spawnSync(process.execPath, ["./dist/commands/rooms-status.js"], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, CLAUDE_CODE_SESSION_ID: meSid },
      encoding: "utf8",
      timeout: 8000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Room: rs-room/);
    assert.match(res.stdout, /ryan \(online\) - demo on feat\/users at abc1234 \(clean\)/);
    assert.match(res.stdout, /last prompt: "add a \/users endpoint with pagination"/);
    assert.match(res.stdout, /plan: add \/users endpoint with pagination \(2\/5 done\)/);
    assert.match(res.stdout, /territory: src\/api\/users\.\* \(users endpoint\)/);
  } finally {
    await stopMcp(child);
  }
});
