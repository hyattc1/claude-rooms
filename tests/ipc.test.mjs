// Integration test for ipc.ts: in-process RPC server + client.
// Verifies wire protocol, discovery files, alive-check, and timeout behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IpcServer,
  IpcClient,
  discoverSocketPath,
  discoverAnyAliveSocket,
  callOnce,
} from "../dist/ipc.js";

function freshDataDir() {
  const d = mkdtempSync(join(tmpdir(), "claude-rooms-ipc-test-"));
  process.env.CLAUDE_PLUGIN_DATA = d;
  return d;
}

test("server -> client roundtrip and method dispatch", async () => {
  freshDataDir();
  const server = new IpcServer();
  server.on("echo", (params) => ({ got: params }));
  server.on("add", ({ a, b }) => a + b);
  await server.start();
  try {
    const sockPath = discoverSocketPath({ ppid: process.ppid });
    assert.ok(sockPath, "by-ppid manifest should exist after server.start()");
    const client = new IpcClient(sockPath);
    await client.connect();
    const r1 = await client.call("echo", { hello: "world" });
    assert.deepEqual(r1, { got: { hello: "world" } });
    const r2 = await client.call("add", { a: 2, b: 3 });
    assert.equal(r2, 5);
    client.close();
  } finally {
    await server.stop();
  }
});

test("by-session manifest published after publishBySession", async () => {
  const dir = freshDataDir();
  const server = new IpcServer();
  await server.start();
  try {
    server.publishBySession("abc-123-session");
    const sockPath = discoverSocketPath({ sessionId: "abc-123-session" });
    assert.ok(sockPath, "by-session lookup should resolve");
    // Both manifests should exist on disk.
    const files = readdirSync(join(dir, "sockets"));
    assert.ok(files.some((f) => f.startsWith("by-ppid-")));
    assert.ok(files.some((f) => f.startsWith("by-session-abc-123-session")));
  } finally {
    await server.stop();
  }
});

test("client errors propagate as Error with message", async () => {
  freshDataDir();
  const server = new IpcServer();
  server.on("boom", () => { throw new Error("kapow"); });
  await server.start();
  try {
    const sockPath = discoverSocketPath({ ppid: process.ppid });
    const client = new IpcClient(sockPath);
    await client.connect();
    await assert.rejects(client.call("boom"), /kapow/);
    client.close();
  } finally {
    await server.stop();
  }
});

test("unknown method returns error", async () => {
  freshDataDir();
  const server = new IpcServer();
  await server.start();
  try {
    const sockPath = discoverSocketPath({ ppid: process.ppid });
    const client = new IpcClient(sockPath);
    await client.connect();
    await assert.rejects(client.call("nope"), /unknown method/);
    client.close();
  } finally {
    await server.stop();
  }
});

test("callOnce returns null when no MCP is reachable", async () => {
  freshDataDir();
  const r = await callOnce("get_state", null, { ppid: 999999 }, 500);
  assert.equal(r, null);
});

test("discoverAnyAliveSocket finds an alive server", async () => {
  freshDataDir();
  const server = new IpcServer();
  server.on("ping", () => "pong");
  await server.start();
  try {
    const p = discoverAnyAliveSocket();
    assert.ok(p, "should find any alive socket");
    const client = new IpcClient(p);
    await client.connect();
    assert.equal(await client.call("ping"), "pong");
    client.close();
  } finally {
    await server.stop();
  }
});

test("server cleanup removes registry files and socket", async () => {
  const dir = freshDataDir();
  const server = new IpcServer();
  await server.start();
  server.publishBySession("clean-test");
  await server.stop();
  const sockets = existsSync(join(dir, "sockets")) ? readdirSync(join(dir, "sockets")) : [];
  // No registry files should remain.
  const remaining = sockets.filter((f) => f.startsWith("by-"));
  assert.deepEqual(remaining, [], `unexpected manifests left: ${remaining.join(",")}`);
});
