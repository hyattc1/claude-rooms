// End-to-end test of the hook scripts against a live MCP server.
// Exercises SessionStart context injection, PreToolUse allow + deny paths
// (single-process: we run two MCP servers with shared Y state via direct
// session-store seeds), PostToolUse state mutation, and SessionEnd cleanup.
//
// Where a real two-peer-mesh is needed (cross-actor lock denial), we
// emulate by manually planting a teammate's actor + lock entries via the
// MCP server's IPC surface running under a different session id.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IpcClient, discoverSocketPath } from "../dist/ipc.js";

function uniqueDir() {
  return mkdtempSync(join(tmpdir(), "claude-rooms-hooks-test-"));
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
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
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

function seedSession(dir, sessionId, room, actor) {
  const ssDir = join(dir, "sessions");
  mkdirSync(ssDir, { recursive: true });
  writeFileSync(join(ssDir, `${sessionId}.json`), JSON.stringify({
    room_code: room, actor_name: actor, joined_at_ms: Date.now(),
  }));
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

test("session-start emits room context when in a room", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const sid = "sess-sstart";
    seedSession(dir, sid, "kite-frog", "connor");
    // Prime the MCP so the room exists in its RoomManager.
    const path = discoverSocketPath({ ppid: process.pid });
    const ipc = new IpcClient(path);
    await ipc.connect();
    await ipc.call("room_status", { session_id: sid });
    ipc.close();

    const r = runHook("session-start", { session_id: sid, hook_event_name: "SessionStart", cwd: process.cwd() }, {
      CLAUDE_PLUGIN_DATA: dir,
    });
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(payload.hookSpecificOutput.additionalContext, /Room: kite-frog/);
    assert.match(payload.hookSpecificOutput.additionalContext, /read_room_state/);
    assert.match(payload.hookSpecificOutput.additionalContext, /update_my_focus/);
  } finally {
    await stopMcp(child);
  }
});

test("session-start fails open with no session-store", async () => {
  const dir = uniqueDir();
  const r = runHook("session-start", { session_id: "nobody", hook_event_name: "SessionStart" }, {
    CLAUDE_PLUGIN_DATA: dir,
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("pre-edit allows when file is unheld", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const sid = "sess-preedit-allow";
    seedSession(dir, sid, "lock-room", "connor");
    const r = runHook("pre-edit", {
      session_id: sid,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/anything.ts", old_string: "a", new_string: "b" },
      cwd: process.cwd(),
    }, { CLAUDE_PLUGIN_DATA: dir });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    if (r.stdout.trim().length > 0) {
      const payload = JSON.parse(r.stdout);
      // If we emit anything, it should be the allow-reminder, not a deny.
      assert.notEqual(payload.hookSpecificOutput.permissionDecision, "deny");
      assert.match(payload.hookSpecificOutput.additionalContext, /claude-rooms file-edit coordination/);
    }
  } finally {
    await stopMcp(child);
  }
});

test("pre-edit denies when teammate holds the lock", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const meSid = "sess-me";
    const otherSid = "sess-other";
    seedSession(dir, meSid, "shared-room", "connor");
    seedSession(dir, otherSid, "shared-room", "ryan");

    // Teammate (ryan) acquires the lock via IPC.
    const path = discoverSocketPath({ ppid: process.pid });
    const ipc = new IpcClient(path);
    await ipc.connect();
    const acq = await ipc.call("try_acquire_locks", { session_id: otherSid, files: ["/tmp/shared.ts"] });
    assert.equal(acq.ok, true);

    // I try to edit /tmp/shared.ts; pre-edit should deny.
    const r = runHook("pre-edit", {
      session_id: meSid,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/shared.ts", old_string: "a", new_string: "b" },
      cwd: process.cwd(),
    }, { CLAUDE_PLUGIN_DATA: dir });
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.hookSpecificOutput.permissionDecision, "deny");
    assert.match(payload.hookSpecificOutput.permissionDecisionReason, /currently held by ryan/);
    assert.match(payload.hookSpecificOutput.additionalContext, /\/rooms-status/);
    ipc.close();
  } finally {
    await stopMcp(child);
  }
});

test("pre-edit fails open when MCP is unreachable", async () => {
  const dir = uniqueDir();
  // No MCP server. seed session anyway so we are nominally in a room.
  const sid = "sess-fail-open";
  seedSession(dir, sid, "any-room", "connor");
  const r = runHook("pre-edit", {
    session_id: sid,
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "/tmp/whatever.ts", old_string: "x", new_string: "y" },
    cwd: process.cwd(),
  }, { CLAUDE_PLUGIN_DATA: dir });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  // Either no output or a non-deny payload.
  if (r.stdout.trim().length > 0) {
    const payload = JSON.parse(r.stdout);
    assert.notEqual(payload.hookSpecificOutput.permissionDecision, "deny");
  }
});

test("pre-edit handles MultiEdit (single file_path with edits[])", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const meSid = "sess-me-multi";
    const otherSid = "sess-other-multi";
    seedSession(dir, meSid, "multi-room", "connor");
    seedSession(dir, otherSid, "multi-room", "ryan");
    const path = discoverSocketPath({ ppid: process.pid });
    const ipc = new IpcClient(path);
    await ipc.connect();
    await ipc.call("try_acquire_locks", { session_id: otherSid, files: ["/tmp/multi.ts"] });
    const r = runHook("pre-edit", {
      session_id: meSid,
      hook_event_name: "PreToolUse",
      tool_name: "MultiEdit",
      tool_input: {
        file_path: "/tmp/multi.ts",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d" },
        ],
      },
      cwd: process.cwd(),
    }, { CLAUDE_PLUGIN_DATA: dir });
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.hookSpecificOutput.permissionDecision, "deny");
    assert.match(payload.hookSpecificOutput.permissionDecisionReason, /multi\.ts/);
    ipc.close();
  } finally {
    await stopMcp(child);
  }
});

test("post-edit records last_action with files in actor state", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const sid = "sess-post";
    seedSession(dir, sid, "post-room", "connor");
    runHook("post-edit", {
      session_id: sid,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/foo.ts", content: "x" },
      cwd: process.cwd(),
    }, { CLAUDE_PLUGIN_DATA: dir });

    // Allow debounce to flush.
    await new Promise((res) => setTimeout(res, 400));

    const path = discoverSocketPath({ ppid: process.pid });
    const ipc = new IpcClient(path);
    await ipc.connect();
    const got = await ipc.call("get_state", { session_id: sid });
    ipc.close();
    assert.equal(got.in_room, true);
    const me = got.snapshot.actors.find((a) => a.actor === "connor");
    assert.ok(me.last_action);
    assert.equal(me.last_action.type, "write");
    assert.deepEqual(me.files_open, ["/tmp/foo.ts"]);
  } finally {
    await stopMcp(child);
  }
});

test("session-end marks the actor offline and releases locks", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const sid = "sess-end";
    seedSession(dir, sid, "end-room", "connor");
    const path = discoverSocketPath({ ppid: process.pid });
    const ipc = new IpcClient(path);
    await ipc.connect();
    await ipc.call("try_acquire_locks", { session_id: sid, files: ["/tmp/end.ts"] });
    // Confirm lock is held.
    let st = await ipc.call("get_state", { session_id: sid });
    assert.ok(st.in_room && st.snapshot.locks.some((l) => l.file === "/tmp/end.ts"));

    runHook("session-end", { session_id: sid, hook_event_name: "SessionEnd", reason: "logout" }, {
      CLAUDE_PLUGIN_DATA: dir,
    });
    // After mark_offline, the manager removes the room. A fresh get_state
    // will re-create the room (because session-store still exists), but
    // the actor state on disk has been cleared from the in-memory Y.Doc.
    // We mainly want to verify the lock is gone.
    st = await ipc.call("get_state", { session_id: sid });
    if (st.in_room) {
      const hasLock = st.snapshot.locks.some((l) => l.file === "/tmp/end.ts");
      assert.equal(hasLock, false, "lock should be released on session-end");
    }
    ipc.close();
  } finally {
    await stopMcp(child);
  }
});

test("stop hook calls record_action (no crash)", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  try {
    const sid = "sess-stop";
    seedSession(dir, sid, "stop-room", "connor");
    const r = runHook("stop", { session_id: sid, hook_event_name: "Stop", stop_reason: "end_turn" }, {
      CLAUDE_PLUGIN_DATA: dir,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  } finally {
    await stopMcp(child);
  }
});
