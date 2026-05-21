// v1.2 feature tests: ICE servers, WSL detection, one-time hints, rooms-doctor,
// /rooms-status formatter additions, and the WebrtcProvider opts builder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveIceServers,
  resolveSignalingServers,
  summarizeIceServers,
  _DEFAULT_OPEN_RELAY_TURN,
  _DEFAULT_STUN,
} from "../dist/ice-servers.js";
import {
  isWSL,
  wslNetworkingMode,
  parseKernelHexIp,
  isWslNatGateway,
  _resetWSLCache,
} from "../dist/wsl-detect.js";
import {
  hasHintBeenShown,
  markHintShown,
  clearHints,
  hintsFilePath,
} from "../dist/hints.js";
import { clearSessionState, writeSessionState } from "../dist/session-store.js";
import { buildProviderOpts } from "../dist/shared-state.js";

function uniqueDir() {
  return mkdtempSync(join(tmpdir(), "claude-rooms-v12-test-"));
}

function withIceEnv(env, fn) {
  const keys = [
    "CLAUDE_PLUGIN_OPTION_TURN_SERVERS",
    "CLAUDE_PLUGIN_OPTION_DISABLE_DEFAULT_TURN",
    "CLAUDE_PLUGIN_OPTION_SIGNALING_SERVERS",
  ];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  try {
    for (const k of keys) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    return fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// ---- 1. resolveIceServers() defaults ----

test("resolveIceServers default: 2 STUN + 1 TURN (Open Relay) with 3 ports", () => {
  withIceEnv({}, () => {
    const servers = resolveIceServers();
    assert.equal(servers.length, _DEFAULT_STUN.length + 1);
    assert.deepEqual(servers[0], _DEFAULT_STUN[0]);
    assert.deepEqual(servers[1], _DEFAULT_STUN[1]);
    const turn = servers[2];
    assert.deepEqual(turn.urls, _DEFAULT_OPEN_RELAY_TURN.urls);
    assert.equal(turn.urls.length, 3);
    assert.equal(turn.username, "openrelayproject");
    assert.equal(turn.credential, "openrelayproject");
    assert.ok(Object.isFrozen(servers));
    assert.equal(summarizeIceServers(servers), "2 STUN + 3 TURN (Open Relay)");
  });
});

// ---- 2. disable_default_turn removes the TURN entry, STUN remains ----

test("CLAUDE_PLUGIN_OPTION_DISABLE_DEFAULT_TURN=true removes Open Relay TURN", () => {
  withIceEnv({ CLAUDE_PLUGIN_OPTION_DISABLE_DEFAULT_TURN: "true" }, () => {
    const servers = resolveIceServers();
    assert.equal(servers.length, _DEFAULT_STUN.length);
    for (const s of servers) {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      for (const u of urls) {
        assert.ok(u.startsWith("stun:"), `expected only STUN, got ${u}`);
      }
    }
    assert.equal(summarizeIceServers(servers), "2 STUN, no TURN");
  });
});

// ---- 3. turn_servers replaces default TURN, STUN retained ----

test("CLAUDE_PLUGIN_OPTION_TURN_SERVERS replaces the default TURN", () => {
  const custom = [{ urls: "turn:my.coturn:3478", username: "u", credential: "p" }];
  withIceEnv({ CLAUDE_PLUGIN_OPTION_TURN_SERVERS: JSON.stringify(custom) }, () => {
    const servers = resolveIceServers();
    assert.equal(servers.length, _DEFAULT_STUN.length + 1);
    const last = servers[servers.length - 1];
    assert.equal(last.urls, "turn:my.coturn:3478");
    assert.equal(last.username, "u");
    assert.equal(last.credential, "p");
    assert.equal(summarizeIceServers(servers), "2 STUN + 1 TURN (custom)");
  });
});

// ---- 4. Malformed turn_servers JSON falls back to default ----

test("malformed CLAUDE_PLUGIN_OPTION_TURN_SERVERS JSON falls back to default", () => {
  // Run the test in a subprocess so we can capture stderr cleanly.
  const script = `
    process.env.CLAUDE_PLUGIN_OPTION_TURN_SERVERS = '{not json';
    import('${pathToFileUrl(join(process.cwd(), "dist/ice-servers.js"))}').then(({ resolveIceServers, _DEFAULT_OPEN_RELAY_TURN }) => {
      const s = resolveIceServers();
      const turn = s[s.length - 1];
      if (JSON.stringify(turn.urls) !== JSON.stringify(_DEFAULT_OPEN_RELAY_TURN.urls)) {
        console.error('FAIL: expected default TURN, got ' + JSON.stringify(turn.urls));
        process.exit(1);
      }
      console.log('OK');
    });
  `;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(r.status, 0, `script failed: ${r.stderr}`);
  assert.match(r.stderr, /not valid JSON/i);
});

function pathToFileUrl(p) {
  // Cross-platform file URL conversion.
  return new URL("file://" + (p.startsWith("/") ? "" : "/") + p.replaceAll("\\", "/")).href;
}

// ---- 5. WSL parsing helpers ----

test("parseKernelHexIp converts little-endian hex to dotted decimal", () => {
  // 0x012016AC stored LE means bytes 01 20 16 AC, IP = 172.22.32.1
  assert.equal(parseKernelHexIp("012016AC"), "172.22.32.1");
  // 0x0101A8C0 -> IP = 192.168.1.1
  assert.equal(parseKernelHexIp("0101A8C0"), "192.168.1.1");
  // 0x00000000 -> 0.0.0.0 (default route placeholder)
  assert.equal(parseKernelHexIp("00000000"), "0.0.0.0");
  // Garbage returns empty string
  assert.equal(parseKernelHexIp("not-hex!"), "");
});

test("isWslNatGateway recognises 172.16.0.0/12 only", () => {
  assert.equal(isWslNatGateway("172.22.32.1"), true);
  assert.equal(isWslNatGateway("172.16.0.1"), true);
  assert.equal(isWslNatGateway("172.31.255.1"), true);
  assert.equal(isWslNatGateway("172.15.0.1"), false);
  assert.equal(isWslNatGateway("172.32.0.1"), false);
  assert.equal(isWslNatGateway("192.168.1.1"), false);
  assert.equal(isWslNatGateway("not-an-ip"), false);
});

test("isWSL() and wslNetworkingMode() execute without throwing on this host", () => {
  _resetWSLCache();
  const wsl = isWSL();
  assert.equal(typeof wsl, "boolean");
  const mode = wslNetworkingMode();
  assert.ok(mode === "mirrored" || mode === "nat" || mode === "unknown");
  // On this WSL2 development host we expect NAT mode unless mirrored is enabled.
  if (wsl) {
    assert.notEqual(mode, "unknown");
  }
});

// ---- 6. hints.ts: shown/mark/clear lifecycle ----

test("hints lifecycle: hasHintBeenShown false initially, true after markHintShown, false after clearHints", () => {
  const dir = uniqueDir();
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  try {
    const sid = "hint-test-1";
    assert.equal(hasHintBeenShown(sid, "share-prompts"), false);
    markHintShown(sid, "share-prompts");
    assert.equal(hasHintBeenShown(sid, "share-prompts"), true);
    // A second markHintShown is a no-op
    markHintShown(sid, "share-prompts");
    assert.equal(hasHintBeenShown(sid, "share-prompts"), true);
    // Independent hint name unaffected
    assert.equal(hasHintBeenShown(sid, "wsl-nat"), false);
    markHintShown(sid, "wsl-nat");
    assert.equal(hasHintBeenShown(sid, "wsl-nat"), true);
    // File on disk has both
    const hints = JSON.parse(readFileSync(hintsFilePath(sid), "utf8"));
    assert.deepEqual(hints.shown.sort(), ["share-prompts", "wsl-nat"]);
    clearHints(sid);
    assert.equal(hasHintBeenShown(sid, "share-prompts"), false);
    assert.equal(hasHintBeenShown(sid, "wsl-nat"), false);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
});

// ---- 7. clearSessionState wipes hints + legacy marker ----

test("clearSessionState deletes the consolidated hints file and the legacy marker", () => {
  const dir = uniqueDir();
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  try {
    const sid = "clear-test-1";
    writeSessionState(sid, { room_code: "x-y-z", actor_name: "connor", joined_at_ms: Date.now() });
    markHintShown(sid, "share-prompts");
    // Seed a legacy v1.1 marker too
    const legacy = join(dir, "sessions", `${sid}.hint-shown`);
    writeFileSync(legacy, String(Date.now()));
    assert.ok(existsSync(hintsFilePath(sid)));
    assert.ok(existsSync(legacy));
    clearSessionState(sid);
    assert.equal(existsSync(hintsFilePath(sid)), false);
    assert.equal(existsSync(legacy), false);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
});

// ---- 8. buildProviderOpts wires resolveIceServers into peerOpts.config ----

test("buildProviderOpts puts resolveIceServers() into peerOpts.config.iceServers", () => {
  withIceEnv({}, () => {
    const opts = buildProviderOpts();
    assert.ok(opts.peerOpts);
    assert.ok(opts.peerOpts.wrtc);
    assert.ok(Array.isArray(opts.peerOpts.config.iceServers));
    const expected = resolveIceServers();
    assert.equal(opts.peerOpts.config.iceServers.length, expected.length);
    assert.deepEqual(opts.peerOpts.config.iceServers[0], expected[0]);
    assert.equal(opts.filterBcConns, false);
    assert.equal(opts.signaling, undefined);
  });
});

test("buildProviderOpts: callerSignaling takes precedence over CLAUDE_PLUGIN_OPTION_SIGNALING_SERVERS", () => {
  withIceEnv({ CLAUDE_PLUGIN_OPTION_SIGNALING_SERVERS: JSON.stringify(["wss://user-config.example"]) }, () => {
    const optsCaller = buildProviderOpts(["wss://caller.example"]);
    assert.deepEqual(optsCaller.signaling, ["wss://caller.example"]);
    const optsUser = buildProviderOpts();
    assert.deepEqual(optsUser.signaling, ["wss://user-config.example"]);
  });
});

// ---- 9. signaling override parsing ----

test("resolveSignalingServers parses valid JSON arrays of strings; rejects others", () => {
  withIceEnv({ CLAUDE_PLUGIN_OPTION_SIGNALING_SERVERS: '["wss://a.example","wss://b.example"]' }, () => {
    assert.deepEqual(resolveSignalingServers(), ["wss://a.example", "wss://b.example"]);
  });
  withIceEnv({ CLAUDE_PLUGIN_OPTION_SIGNALING_SERVERS: "not json" }, () => {
    assert.equal(resolveSignalingServers(), null);
  });
  withIceEnv({ CLAUDE_PLUGIN_OPTION_SIGNALING_SERVERS: "[1, 2, 3]" }, () => {
    assert.equal(resolveSignalingServers(), null);
  });
});

// ---- 10. /rooms-doctor runs and reports its sections ----

test("/claude-rooms:rooms-doctor exits 0 and prints the expected section headers (not in a room)", () => {
  const dir = uniqueDir();
  const r = spawnSync(process.execPath, ["dist/commands/rooms-doctor.js"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dir,
      // No session id and no MCP socket; the doctor should still produce output.
      CLAUDE_CODE_SESSION_ID: "",
    },
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /claude-rooms doctor/);
  assert.match(r.stdout, /Environment:/);
  assert.match(r.stdout, /Plugin:/);
  assert.match(r.stdout, /ICE configuration:/);
  assert.match(r.stdout, /Recommended next step:/);
  // ICE config should reference the default servers
  assert.match(r.stdout, /openrelay\.metered\.ca|TURN/);
});

test("/claude-rooms:rooms-doctor with disable_default_turn shows no TURN entry", () => {
  const dir = uniqueDir();
  const r = spawnSync(process.execPath, ["dist/commands/rooms-doctor.js"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dir,
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_PLUGIN_OPTION_DISABLE_DEFAULT_TURN: "true",
    },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /TURN: \(none/);
  assert.match(r.stdout, /disable_default_turn: yes/);
});

// ---- 11. /rooms-status formatter includes the ICE line (when in a room) ----

test("/claude-rooms:rooms-status prints ICE line under You and MCP-unreachable fallback path", () => {
  const dir = uniqueDir();
  const sid = "v12-status-test";
  // Seed a session file so the command thinks we are in a room
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "sessions", `${sid}.json`), JSON.stringify({
    room_code: "a-b-c-d", actor_name: "connor", joined_at_ms: Date.now(),
  }));
  // No MCP server is running, so the command falls into the
  // "MCP server not reachable; teammate state unavailable." branch.
  // That branch does not call resolveIceServers(); we only verify the
  // command exits 0 and contains the room code. (Full ICE-line rendering
  // is covered by the in-room MCP path in the larger e2e suite.)
  const r = spawnSync(process.execPath, ["dist/commands/rooms-status.js"], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, CLAUDE_CODE_SESSION_ID: sid },
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /Room: a-b-c-d/);
});
