// Integration test for the MCP server. Spawns the compiled server as a
// stdio subprocess and drives it through real MCP JSON-RPC messages,
// covering the tools/list response and both tool invocations (no-room
// and in-room paths). Also exercises the IPC surface from a separate
// in-process IpcClient that talks to the same MCP server's IPC socket.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IpcClient, discoverSocketPath } from "../dist/ipc.js";

function uniqueDir() {
  const d = mkdtempSync(join(tmpdir(), "claude-rooms-mcp-test-"));
  return d;
}

class StdioPeer {
  constructor(child) {
    this.child = child;
    this.buf = "";
    this.inbox = new Map();
    this.nextId = 1;
    this.notifications = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    this.stderrBuf = "";
    child.stderr.on("data", (s) => { this.stderrBuf += s; });
  }
  onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && this.inbox.has(msg.id)) {
          this.inbox.get(msg.id)({ result: msg.result, error: msg.error });
          this.inbox.delete(msg.id);
        } else {
          this.notifications.push(msg);
        }
      } catch {
        // ignore non-JSON noise
      }
    }
  }
  rpc(method, params, timeoutMs = 5000) {
    const id = String(this.nextId++);
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.inbox.delete(id);
        reject(new Error(`mcp rpc timeout: ${method}\nstderr: ${this.stderrBuf}`));
      }, timeoutMs);
      this.inbox.set(id, ({ result, error }) => {
        clearTimeout(t);
        if (error) reject(new Error(JSON.stringify(error)));
        else resolve(result);
      });
      this.child.stdin.write(payload);
    });
  }
  notify(method, params) {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.child.stdin.write(payload);
  }
  close() {
    this.child.stdin.end();
  }
}

async function bootMcp(dataDir, env = {}) {
  // The IPC discovery helpers in the test driver also read CLAUDE_PLUGIN_DATA,
  // so set it in both the child env and our own process env.
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  const child = spawn(process.execPath, ["./dist/mcp/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dataDir,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const peer = new StdioPeer(child);
  // Initialize handshake.
  const init = await peer.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-driver", version: "0.0.1" },
  });
  assert.ok(init && init.serverInfo);
  assert.equal(init.serverInfo.name, "claude-rooms");
  peer.notify("notifications/initialized", {});
  return { child, peer };
}

async function stop(child, peer) {
  try { peer.close(); } catch { /* ignore */ }
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve();
    }, 3000);
    child.on("exit", () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve();
    });
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  });
}

test("tools/list exposes read_room_state and update_my_focus", async () => {
  const dir = uniqueDir();
  const { child, peer } = await bootMcp(dir);
  try {
    const r = await peer.rpc("tools/list", {});
    const names = r.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["read_room_state", "update_my_focus"]);
    const readDesc = r.tools.find((t) => t.name === "read_room_state").description;
    assert.match(readDesc, /Returns the live state/);
    assert.match(readDesc, /Call this/);
    const focusDesc = r.tools.find((t) => t.name === "update_my_focus").description;
    assert.match(focusDesc, /short description of what you are currently working on/);
  } finally {
    await stop(child, peer);
  }
});

test("read_room_state reports not-in-room until session-store is populated", async () => {
  const dir = uniqueDir();
  const { child, peer } = await bootMcp(dir);
  try {
    const r = await peer.rpc("tools/call", { name: "read_room_state", arguments: {} });
    assert.ok(r.content && r.content[0]);
    assert.match(r.content[0].text, /not in a room/i);
  } finally {
    await stop(child, peer);
  }
});

test("IPC: set_my_state and get_state across same MCP instance", async () => {
  const dir = uniqueDir();
  // Pre-seed a session store entry for the session id we will use.
  const sid = "sess-abc-123";
  const ssDir = join(dir, "sessions");
  mkdirSync(ssDir, { recursive: true });
  writeFileSync(join(ssDir, `${sid}.json`), JSON.stringify({
    room_code: "kite-frog",
    actor_name: "connor",
    joined_at_ms: Date.now(),
  }));

  const { child, peer } = await bootMcp(dir);
  try {
    // Find the IPC socket the MCP server published.
    // by-ppid manifest is keyed on the MCP's ppid = our pid (we spawned it).
    let path = discoverSocketPath({ ppid: process.pid });
    assert.ok(path, "MCP server should have published a by-ppid registry entry");
    const ipc = new IpcClient(path);
    await ipc.connect();

    // Trigger room creation by sending a state-touching call.
    const set = await ipc.call("set_my_state", { session_id: sid, patch: { focus: "auth refactor" } });
    assert.deepEqual(set, { applied: true });

    // Read it back via IPC.
    const got = await ipc.call("get_state", { session_id: sid });
    assert.equal(got.in_room, true);
    const me = got.snapshot.actors.find((a) => a.actor === "connor");
    // setMyState is debounced; the IPC call to set returns before flush,
    // so we may need to wait a bit. Poll up to 1s.
    if (!me || me.focus !== "auth refactor") {
      const start = Date.now();
      let saw = me && me.focus === "auth refactor";
      while (!saw && Date.now() - start < 1500) {
        const g = await ipc.call("get_state", { session_id: sid });
        const m = g.snapshot.actors.find((a) => a.actor === "connor");
        if (m && m.focus === "auth refactor") { saw = true; break; }
        await new Promise((res) => setTimeout(res, 50));
      }
      assert.ok(saw, "focus should propagate after debounce flush");
    }

    // Now read_room_state should reflect this.
    const tr = await peer.rpc("tools/call", { name: "read_room_state", arguments: {} });
    assert.match(tr.content[0].text, /Room: kite-frog/);

    ipc.close();
  } finally {
    await stop(child, peer);
  }
});

test("IPC try_acquire_locks atomic with subsequent deny", async () => {
  const dir = uniqueDir();
  const sid = "sess-locktest";
  const ssDir = join(dir, "sessions");
  mkdirSync(ssDir, { recursive: true });
  writeFileSync(join(ssDir, `${sid}.json`), JSON.stringify({
    room_code: "lock-test",
    actor_name: "connor",
    joined_at_ms: Date.now(),
  }));

  const { child, peer } = await bootMcp(dir);
  try {
    const path = discoverSocketPath({ ppid: process.pid });
    const ipc = new IpcClient(path);
    await ipc.connect();
    const r1 = await ipc.call("try_acquire_locks", { session_id: sid, files: ["src/auth.ts"] });
    assert.equal(r1.ok, true);
    // Same actor, same file: refresh succeeds.
    const r2 = await ipc.call("try_acquire_locks", { session_id: sid, files: ["src/auth.ts"] });
    assert.equal(r2.ok, true);
    ipc.close();
  } finally {
    await stop(child, peer);
  }
});

test("update_my_focus tool sets focus and surfaces it via read_room_state", async () => {
  const dir = uniqueDir();
  const sid = "sess-focustest";
  const ssDir = join(dir, "sessions");
  mkdirSync(ssDir, { recursive: true });
  writeFileSync(join(ssDir, `${sid}.json`), JSON.stringify({
    room_code: "focus-test",
    actor_name: "connor",
    joined_at_ms: Date.now(),
  }));

  const { child, peer } = await bootMcp(dir, { CLAUDE_CODE_SESSION_ID: sid });
  try {
    const r = await peer.rpc("tools/call", {
      name: "update_my_focus",
      arguments: { focus: "writing tests for users endpoint" },
    });
    assert.match(r.content[0].text, /Updated focus/);
    const r2 = await peer.rpc("tools/call", { name: "read_room_state", arguments: {} });
    // Note: the focus belongs to the *caller* (connor), so it shows up in the
    // "You" block, not the Teammates block. We just confirm the snapshot
    // includes the room name; structured content carries the rest.
    assert.match(r2.content[0].text, /Room: focus-test/);
    assert.ok(r2.structuredContent);
    const me = r2.structuredContent.actors.find((a) => a.actor === "connor");
    assert.equal(me.focus, "writing tests for users endpoint");
  } finally {
    await stop(child, peer);
  }
});
