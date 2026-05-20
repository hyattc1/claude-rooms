// Slash-command end-to-end test: spawns the MCP server and then runs the
// compiled command scripts as subprocesses, verifying actual stdout and
// resulting session-store + IPC state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function uniqueDir() {
  return mkdtempSync(join(tmpdir(), "claude-rooms-slash-test-"));
}

async function bootMcp(dataDir) {
  const child = spawn(process.execPath, ["./dist/mcp/server.js"], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  // Initialize handshake so the server is ready for IPC.
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
          if (msg.id === "init") {
            child.stdout.off("data", onData);
            resolve();
          }
        } catch { /* ignore */ }
      }
    };
    child.stdout.on("data", onData);
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: "init", method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }) + "\n");
    setTimeout(() => reject(new Error("mcp initialize timeout")), 5000);
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

function runCmd(name, args, env, unset = []) {
  const finalEnv = { ...process.env, ...env };
  for (const k of unset) delete finalEnv[k];
  const res = spawnSync(process.execPath, [`./dist/commands/${name}.js`, ...(args ?? [])], {
    env: finalEnv,
    encoding: "utf8",
    timeout: 15000,
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

test("create -> status -> leave roundtrip", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  const sid = "slash-sess-1";
  const env = { CLAUDE_PLUGIN_DATA: dir, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PLUGIN_OPTION_ACTOR_NAME: "connor" };
  try {
    const created = runCmd("rooms-create", [], env);
    assert.equal(created.status, 0, `stderr: ${created.stderr}`);
    assert.match(created.stdout, /^Room: [a-z]+-[a-z]+/m, `stdout: ${created.stdout}`);
    assert.match(created.stdout, /joined as connor/);

    // session-store written
    const ssPath = join(dir, "sessions", `${sid}.json`);
    assert.ok(existsSync(ssPath));
    const ss = JSON.parse(readFileSync(ssPath, "utf8"));
    assert.match(ss.room_code, /^[a-z]+-[a-z]+$/);
    const roomCode = ss.room_code;
    assert.equal(ss.actor_name, "connor");

    const status = runCmd("rooms-status", [], env);
    assert.equal(status.status, 0, `stderr: ${status.stderr}`);
    assert.match(status.stdout, new RegExp(`Room: ${roomCode}`));
    assert.match(status.stdout, /You: connor \(online\)/);

    const left = runCmd("rooms-leave", [], env);
    assert.equal(left.status, 0, `stderr: ${left.stderr}`);
    assert.match(left.stdout, new RegExp(`Left room ${roomCode}`));
    assert.ok(!existsSync(ssPath), "session store should be cleared");

    const statusAfter = runCmd("rooms-status", [], env);
    assert.match(statusAfter.stdout, /Not currently in a room/);
  } finally {
    await stopMcp(child);
  }
});

test("join with bad code rejects with helpful message", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  const env = { CLAUDE_PLUGIN_DATA: dir, CLAUDE_CODE_SESSION_ID: "sid-bad" };
  try {
    const r1 = runCmd("rooms-join", ["NOT VALID"], env);
    assert.notEqual(r1.status, 0);
    assert.match(r1.stdout, /does not look like a room code/);
  } finally {
    await stopMcp(child);
  }
});

test("join with no peer detected prints warning", async () => {
  const dir = uniqueDir();
  const child = await bootMcp(dir);
  const env = { CLAUDE_PLUGIN_DATA: dir, CLAUDE_CODE_SESSION_ID: "sid-solo", CLAUDE_PLUGIN_OPTION_ACTOR_NAME: "alex" };
  try {
    const r = runCmd("rooms-join", ["solo-room"], env);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Joined room solo-room as alex/);
    assert.match(r.stdout, /no other teammates detected yet/i);
  } finally {
    await stopMcp(child);
  }
});

test("status with no session-store says not in room (no IPC needed)", async () => {
  const dir = uniqueDir();
  const env = { CLAUDE_PLUGIN_DATA: dir, CLAUDE_CODE_SESSION_ID: "sid-empty" };
  const r = runCmd("rooms-status", [], env);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Not currently in a room/);
});

test("create without CLAUDE_CODE_SESSION_ID exits with error", () => {
  const dir = uniqueDir();
  const env = { CLAUDE_PLUGIN_DATA: dir };
  const r = runCmd("rooms-create", [], env, ["CLAUDE_CODE_SESSION_ID"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /CLAUDE_CODE_SESSION_ID is not set/);
});
