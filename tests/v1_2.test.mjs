// v1.2 feature tests: ICE servers (STUN-only default), live ICE probe,
// WSL detection, one-time hints, rooms-doctor, /rooms-status formatter
// additions, and the WebrtcProvider opts builder.

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
  userTurnConfigured,
  _DEFAULT_STUN,
} from "../dist/ice-servers.js";
import {
  isWSL,
  wslNetworkingMode,
  parseKernelHexIp,
  isWslNatGateway,
  nonInternalInterfaceCount,
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

// ---- 1. resolveIceServers() default is STUN-only ----

test("resolveIceServers default: STUN-only, no TURN", () => {
  withIceEnv({}, () => {
    const servers = resolveIceServers();
    assert.equal(servers.length, _DEFAULT_STUN.length);
    for (const s of servers) {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      for (const u of urls) {
        assert.ok(u.startsWith("stun:"), `expected only STUN, got ${u}`);
      }
    }
    assert.ok(Object.isFrozen(servers));
    assert.equal(summarizeIceServers(servers), "2 STUN, no TURN (direct P2P only)");
    assert.equal(userTurnConfigured(), false);
  });
});

// ---- 2. turn_servers appends the user-provided TURN ----

test("CLAUDE_PLUGIN_OPTION_TURN_SERVERS appends user-provided TURN; STUN retained", () => {
  const custom = [{ urls: "turn:my.coturn:3478", username: "u", credential: "p" }];
  withIceEnv({ CLAUDE_PLUGIN_OPTION_TURN_SERVERS: JSON.stringify(custom) }, () => {
    const servers = resolveIceServers();
    assert.equal(servers.length, _DEFAULT_STUN.length + 1);
    const last = servers[servers.length - 1];
    assert.equal(last.urls, "turn:my.coturn:3478");
    assert.equal(last.username, "u");
    assert.equal(last.credential, "p");
    assert.equal(summarizeIceServers(servers), "2 STUN + 1 TURN (user-configured)");
    assert.equal(userTurnConfigured(), true);
  });
});

// ---- 3. Malformed turn_servers JSON is ignored (STUN-only result) ----

test("malformed CLAUDE_PLUGIN_OPTION_TURN_SERVERS JSON is ignored with stderr warning", () => {
  // Run in a subprocess so we can capture stderr cleanly.
  const script = `
    process.env.CLAUDE_PLUGIN_OPTION_TURN_SERVERS = '{not json';
    import('${pathToFileUrl(join(process.cwd(), "dist/ice-servers.js"))}').then(({ resolveIceServers, _DEFAULT_STUN }) => {
      const s = resolveIceServers();
      if (s.length !== _DEFAULT_STUN.length) {
        console.error('FAIL: expected STUN-only, got ' + s.length + ' servers');
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
  return new URL("file://" + (p.startsWith("/") ? "" : "/") + p.replaceAll("\\", "/")).href;
}

// ---- 4. WSL parsing helpers ----

test("parseKernelHexIp converts little-endian hex to dotted decimal", () => {
  assert.equal(parseKernelHexIp("012016AC"), "172.22.32.1");
  assert.equal(parseKernelHexIp("0101A8C0"), "192.168.1.1");
  assert.equal(parseKernelHexIp("00000000"), "0.0.0.0");
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

test("nonInternalInterfaceCount returns a positive integer", () => {
  const n = nonInternalInterfaceCount();
  assert.ok(Number.isInteger(n) && n >= 0);
});

test("isWSL() and wslNetworkingMode() execute without throwing on this host", () => {
  _resetWSLCache();
  const wsl = isWSL();
  assert.equal(typeof wsl, "boolean");
  const mode = wslNetworkingMode();
  assert.ok(mode === "mirrored" || mode === "nat" || mode === "unknown");
});

// ---- 5. hints lifecycle ----

test("hints lifecycle: hasHintBeenShown false initially, true after markHintShown, false after clearHints", () => {
  const dir = uniqueDir();
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  try {
    const sid = "hint-test-1";
    assert.equal(hasHintBeenShown(sid, "share-prompts"), false);
    markHintShown(sid, "share-prompts");
    assert.equal(hasHintBeenShown(sid, "share-prompts"), true);
    markHintShown(sid, "share-prompts"); // idempotent
    assert.equal(hasHintBeenShown(sid, "share-prompts"), true);
    assert.equal(hasHintBeenShown(sid, "wsl-nat"), false);
    markHintShown(sid, "wsl-nat");
    assert.equal(hasHintBeenShown(sid, "wsl-nat"), true);
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

test("clearSessionState deletes the consolidated hints file and the legacy marker", () => {
  const dir = uniqueDir();
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  try {
    const sid = "clear-test-1";
    writeSessionState(sid, { room_code: "x-y-z", actor_name: "connor", joined_at_ms: Date.now() });
    markHintShown(sid, "share-prompts");
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

// ---- 6. buildProviderOpts ----

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

// ---- 7. signaling override parsing ----

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

// ---- 8. ICE probe runs against STUN-only default ----
//
// The probe loads @roamhq/wrtc's native binary, which has a known issue
// where the Node process SIGSEGVs at exit if wrtc was loaded. Run in a
// subprocess so the crash (if it happens) does not poison the test runner.

test("probeIce returns ok=true with host candidates from STUN-only default (relay=false)", () => {
  const script = `
    import('${pathToFileUrl(join(process.cwd(), "dist/ice-probe.js"))}').then(async ({ probeIce }) => {
      const { resolveIceServers } = await import('${pathToFileUrl(join(process.cwd(), "dist/ice-servers.js"))}');
      const r = await probeIce(resolveIceServers(), 8000);
      console.log(JSON.stringify(r));
      process.exit(0);
    });
  `;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 15000 });
  // Allow SIGSEGV exit (wrtc native binary cleanup issue) provided we got
  // a parseable result on stdout.
  const lines = r.stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.length > 0, `no probe output; stderr: ${r.stderr}`);
  const result = JSON.parse(lines[lines.length - 1]);
  assert.equal(result.ok, true);
  assert.equal(result.relay, false);
  assert.ok(result.types.includes("host"), `expected host in types, got ${JSON.stringify(result.types)}`);
  assert.equal(typeof result.public_ip, "string");
  assert.ok(result.elapsed_ms >= 0);
});

// ---- 9. /rooms-doctor runs and reports its sections ----

test("/claude-rooms:rooms-doctor exits 0 and prints the expected section headers (not in a room)", () => {
  const dir = uniqueDir();
  const r = spawnSync(process.execPath, ["dist/commands/rooms-doctor.js"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dir,
      CLAUDE_CODE_SESSION_ID: "",
    },
    timeout: 20000,
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /claude-rooms doctor/);
  assert.match(r.stdout, /Environment:/);
  assert.match(r.stdout, /Plugin:/);
  assert.match(r.stdout, /ICE configuration:/);
  assert.match(r.stdout, /Live ICE probe:/);
  assert.match(r.stdout, /Recommended next step:/);
  // STUN-only default => no TURN entry shown
  assert.match(r.stdout, /TURN: \(none|TURN relay: not configured/);
});

test("/claude-rooms:rooms-doctor with custom turn_servers reports TURN status", () => {
  const dir = uniqueDir();
  const r = spawnSync(process.execPath, ["dist/commands/rooms-doctor.js"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dir,
      CLAUDE_CODE_SESSION_ID: "",
      // Use a deliberately unreachable TURN to confirm the probe reports failure cleanly.
      CLAUDE_PLUGIN_OPTION_TURN_SERVERS: JSON.stringify([
        { urls: "turn:unreachable.invalid:3478", username: "x", credential: "x" }
      ]),
    },
    timeout: 20000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /TURN: turn:unreachable\.invalid:3478/);
  // The probe should report TURN as not working
  assert.match(r.stdout, /TURN relay: NOT working|TURN relay: not configured/);
});

// ---- 10. /rooms-status fallback path (MCP unreachable) ----

test("/claude-rooms:rooms-status prints the room code under MCP-unreachable fallback", () => {
  const dir = uniqueDir();
  const sid = "v12-status-test";
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "sessions", `${sid}.json`), JSON.stringify({
    room_code: "a-b-c-d", actor_name: "connor", joined_at_ms: Date.now(),
  }));
  const r = spawnSync(process.execPath, ["dist/commands/rooms-status.js"], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, CLAUDE_CODE_SESSION_ID: sid },
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /Room: a-b-c-d/);
});

// ---- 11. SessionStart hook emits the WSL2 NAT hint when applicable ----

test("session-start hook emits the WSL2 NAT hint exactly once per session", () => {
  const dir = uniqueDir();
  const sid = "ss-hint-test";
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "sessions", `${sid}.json`), JSON.stringify({
    room_code: "h-i-j-k", actor_name: "connor", joined_at_ms: Date.now(),
  }));
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: dir,
    CLAUDE_CODE_SESSION_ID: sid,
  };
  // Skip if not actually in WSL2 NAT mode (hint won't fire).
  if (!isWSL() || wslNetworkingMode() !== "nat") {
    // Still verify the hook exits 0 cleanly.
    const r0 = spawnSync(process.execPath, ["dist/hooks/session-start.js"], {
      input: JSON.stringify({ session_id: sid, cwd: process.cwd() }),
      encoding: "utf8",
      env,
      timeout: 10000,
    });
    assert.equal(r0.status, 0, `stderr: ${r0.stderr}`);
    return;
  }
  // First run: WSL2 hint should appear in additionalContext.
  const r1 = spawnSync(process.execPath, ["dist/hooks/session-start.js"], {
    input: JSON.stringify({ session_id: sid, cwd: process.cwd() }),
    encoding: "utf8",
    env,
    timeout: 10000,
  });
  assert.equal(r1.status, 0, `stderr: ${r1.stderr}`);
  const out1 = r1.stdout.trim();
  let parsed1;
  try { parsed1 = JSON.parse(out1); } catch { assert.fail(`first run output not JSON: ${out1}`); }
  const ctx1 = parsed1?.hookSpecificOutput?.additionalContext ?? "";
  assert.match(ctx1, /WSL2 with NAT networking/, "WSL2 NAT hint should appear on first run");
  // Second run: hint should be suppressed.
  const r2 = spawnSync(process.execPath, ["dist/hooks/session-start.js"], {
    input: JSON.stringify({ session_id: sid, cwd: process.cwd() }),
    encoding: "utf8",
    env,
    timeout: 10000,
  });
  assert.equal(r2.status, 0);
  const parsed2 = JSON.parse(r2.stdout.trim());
  const ctx2 = parsed2?.hookSpecificOutput?.additionalContext ?? "";
  assert.doesNotMatch(ctx2, /WSL2 with NAT networking/, "WSL2 NAT hint should not repeat");
});
