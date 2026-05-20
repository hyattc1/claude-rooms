// Phase 6 smoke test (Plan, Section "integration smoke"): two MCP server
// processes on the same machine, each its own CLAUDE_PLUGIN_DATA, both
// joined to the same room via REAL y-webrtc through the public signaling
// servers. Verifies that lock writes from one peer are visible to the
// other within a reasonable window.
//
// This test depends on public infrastructure (signaling.yjs.dev and two
// heroku instances baked into y-webrtc), so it is gated behind an env
// switch to keep CI deterministic. Run with:
//   CLAUDE_ROOMS_RUN_SMOKE=1 node --test tests/smoke-cross-process.test.mjs
//
// Locally this is the test that actually validates the v1 demo will work.
//
// Known limitation: WSL2 cannot complete WebRTC peer-to-peer connections
// because the VM's network stack drops the inbound UDP that ICE relies on,
// even with public STUN. We have observed both peers reach signaling but
// neither sees the other's webrtcPeer event. On macOS, Linux native, or
// Windows native this test passes within ~3-15 seconds. The same WSL2 quirk
// affects any y-webrtc app; it is not a claude-rooms bug. For WSL2
// verification, use the TEST_MODE-backed hook/MCP suites which exercise
// every cross-peer code path through a shared in-process Y.Doc.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IpcClient, discoverSocketPath } from "../dist/ipc.js";

const ENABLED = process.env.CLAUDE_ROOMS_RUN_SMOKE === "1";

const FRESH_DIR = () => mkdtempSync(join(tmpdir(), "claude-rooms-smoke-"));

async function bootMcp(dataDir) {
  const child = spawn(process.execPath, ["./dist/mcp/server.js"], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // stderr is useful for debugging when the smoke test misbehaves.
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (s) => { stderr += s; });
  child.stderrAcc = () => stderr;

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
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
    }) + "\n");
    setTimeout(() => reject(new Error("mcp init timeout")), 10000);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return child;
}

async function stopMcp(child) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } resolve(); }, 3000);
    child.on("exit", () => { clearTimeout(t); resolve(); });
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  });
}

function seedSession(dir, sid, room, actor) {
  const d = join(dir, "sessions");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${sid}.json`), JSON.stringify({
    room_code: room, actor_name: actor, joined_at_ms: Date.now(),
  }));
}

async function ipcConnect(dataDir) {
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  const path = discoverSocketPath({ ppid: process.pid });
  assert.ok(path, `no MCP socket found in ${dataDir}`);
  const ipc = new IpcClient(path);
  await ipc.connect(3000);
  return ipc;
}

test(
  "two MCP processes share state over real y-webrtc",
  { skip: !ENABLED },
  async () => {
    const dirA = FRESH_DIR();
    const dirB = FRESH_DIR();
    const roomCode = `smk-${Math.random().toString(36).slice(2, 6)}-${Math.random().toString(36).slice(2, 6)}`;
    const sidA = "smoke-A";
    const sidB = "smoke-B";
    seedSession(dirA, sidA, roomCode, "alice");
    seedSession(dirB, sidB, roomCode, "bob");
    const A = await bootMcp(dirA);
    const B = await bootMcp(dirB);
    try {
      const ipcA = await ipcConnect(dirA);
      const ipcB = await ipcConnect(dirB);
      // Trigger room creation by sending a state-touching call to each.
      await ipcA.call("set_my_state", { session_id: sidA, patch: { focus: "writing tests" } });
      await ipcB.call("set_my_state", { session_id: sidB, patch: { focus: "reviewing diff" } });

      // Poll: wait until each peer sees the other (or fail after a timeout).
      const deadline = Date.now() + 25000;
      let aSeesB = false;
      let bSeesA = false;
      while (Date.now() < deadline && !(aSeesB && bSeesA)) {
        const gA = await ipcA.call("get_state", { session_id: sidA });
        const gB = await ipcB.call("get_state", { session_id: sidB });
        aSeesB = gA.in_room && gA.snapshot.actors.some((a) => a.actor === "bob" && a.focus === "reviewing diff");
        bSeesA = gB.in_room && gB.snapshot.actors.some((a) => a.actor === "alice" && a.focus === "writing tests");
        if (!(aSeesB && bSeesA)) await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(aSeesB, "alice should see bob's focus via y-webrtc");
      assert.ok(bSeesA, "bob should see alice's focus via y-webrtc");

      // Lock denial: alice acquires src/auth.ts, bob tries to acquire it, should fail.
      const acq = await ipcA.call("try_acquire_locks", { session_id: sidA, files: ["src/auth.ts"] });
      assert.equal(acq.ok, true);

      // Poll until bob sees alice's lock.
      const lockDeadline = Date.now() + 15000;
      let bDeniedCorrectly = false;
      while (Date.now() < lockDeadline) {
        const tryB = await ipcB.call("try_acquire_locks", { session_id: sidB, files: ["src/auth.ts"] });
        if (!tryB.ok && tryB.held && tryB.held[0]?.actor === "alice") {
          bDeniedCorrectly = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(bDeniedCorrectly, "bob's try_acquire_locks should be denied with alice as holder");

      ipcA.close();
      ipcB.close();
    } finally {
      await stopMcp(A);
      await stopMcp(B);
    }
  }
);
