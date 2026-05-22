// /claude-rooms:rooms-doctor
//
// Self-debug page. Runs without needing to be in a room. Prints WSL status,
// ICE configuration, MCP socket discovery, a live ICE probe result, current
// room (if any), and a recommended next step. Never modifies state.

import { discoverSocketPath, discoverAnyAliveSocket } from "../ipc.js";
import { readSessionState } from "../session-store.js";
import { sharePromptsEnabled } from "../hooks/_common.js";
import {
  resolveIceServers,
  resolveSignalingServers,
  summarizeIceServers,
  userTurnConfigured,
} from "../ice-servers.js";
import { probeIce, type IceProbeResult } from "../ice-probe.js";
import { isWSL, wslNetworkingMode, readDefaultGateway } from "../wsl-detect.js";
import { getSessionId, exitWith } from "./_common.js";

function describeMcpSocket(sessionId: string | null): { found: boolean; path: string | null } {
  const path = discoverSocketPath({
    sessionId: sessionId ?? undefined,
    ppid: process.ppid,
    cwdForFallback: process.cwd(),
  }) ?? discoverAnyAliveSocket();
  return { found: !!path, path };
}

function recommendation(args: {
  wsl: boolean;
  wslMode: "mirrored" | "nat" | "unknown";
  inRoom: boolean;
  mcpFound: boolean;
  turnConfigured: boolean;
  probeRelay: boolean;
}): string {
  if (!args.mcpFound) {
    return "MCP server not reachable. Restart Claude Code and re-run this command. If it persists, the plugin may need to be reinstalled.";
  }
  if (args.wsl && args.wslMode === "nat" && !args.probeRelay) {
    return "WSL2 NAT mode blocks the inbound UDP that WebRTC needs, and no TURN relay is currently producing relay candidates. Enable WSL2 mirrored mode (Win11 22H2+) per the README \"Running on WSL2\" section for direct peer-to-peer. Alternatively, set the turn_servers userConfig to a known-good TURN endpoint (self-hosted coturn, Cloudflare TURN with HMAC, paid Metered.ca tier).";
  }
  if (args.wsl && args.wslMode === "nat" && args.probeRelay) {
    return "WSL2 NAT mode detected but your TURN config is producing relay candidates, so cross-machine should work via relay. For direct P2P (lower latency, no third-party relay), enable mirrored mode per the README.";
  }
  if (args.turnConfigured && !args.probeRelay) {
    return "Your turn_servers config is set but the live ICE probe did not produce a relay candidate. The TURN endpoint may be unreachable or rejecting your credentials. Verify the URL and creds, or remove the turn_servers entry to use STUN-only.";
  }
  if (args.inRoom) {
    return "Looks good. /claude-rooms:rooms-status to see teammate state.";
  }
  return "Looks good. /claude-rooms:rooms-create or /claude-rooms:rooms-join <code> to get started.";
}

function flatUrls(servers: ReturnType<typeof resolveIceServers>): { stun: string[]; turn: string[] } {
  const stun: string[] = [];
  const turn: string[] = [];
  for (const s of servers) {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    for (const u of urls) {
      if (u.startsWith("stun:")) stun.push(u);
      else if (u.startsWith("turn:") || u.startsWith("turns:")) turn.push(u);
    }
  }
  return { stun, turn };
}

function probeLines(probe: IceProbeResult, turnConfigured: boolean): string[] {
  const lines: string[] = [];
  if (probe.error) {
    lines.push(`  Live ICE probe: failed (${probe.error})`);
    return lines;
  }
  if (!probe.ok) {
    lines.push("  Live ICE probe: did not run");
    return lines;
  }
  const typesLabel = probe.types.length > 0 ? probe.types.join(", ") : "(none)";
  lines.push(`  Live ICE probe (${(probe.elapsed_ms / 1000).toFixed(1)}s): ${typesLabel}`);
  if (probe.public_ip) {
    lines.push(`  Public IPv4 (via STUN): ${probe.public_ip}`);
  }
  if (turnConfigured) {
    lines.push(`  TURN relay: ${probe.relay ? "OK (relay candidate received)" : "NOT working (no relay candidate)"}`);
  } else {
    lines.push("  TURN relay: not configured (set turn_servers to enable a relay)");
  }
  return lines;
}

async function main(): Promise<void> {
  const sessionId = getSessionId();
  const wsl = isWSL();
  const wslMode = wslNetworkingMode();
  const gateway = readDefaultGateway() || "(unknown)";
  const pluginData = process.env.CLAUDE_PLUGIN_DATA ?? "(unset)";
  const sock = describeMcpSocket(sessionId);
  const local = sessionId ? readSessionState(sessionId) : null;
  const inRoom = !!local;

  const ice = resolveIceServers();
  const { stun, turn } = flatUrls(ice);
  const signaling = resolveSignalingServers();
  const turnConfigured = userTurnConfigured();

  const probe = await probeIce(ice, 6000);

  const lines: string[] = [];
  lines.push("claude-rooms doctor");
  lines.push("");
  lines.push("Environment:");
  lines.push(`  WSL2:                ${wsl ? `yes (${wslMode})` : "no"}`);
  lines.push(`  Default gateway:     ${gateway}`);
  lines.push(`  CLAUDE_PLUGIN_DATA:  ${pluginData}`);
  lines.push(`  CLAUDE_CODE_SESSION_ID: ${sessionId ?? "(unset)"}`);
  lines.push("");
  lines.push("Plugin:");
  lines.push(`  MCP socket present:  ${sock.found ? `yes (${sock.path})` : "no"}`);
  lines.push(`  Current room:        ${local ? `${local.room_code} as ${local.actor_name}` : "not in a room"}`);
  lines.push("");
  lines.push("ICE configuration:");
  lines.push(`  Summary:             ${summarizeIceServers(ice)}`);
  if (stun.length > 0) lines.push(`  STUN: ${stun.join(", ")}`);
  if (turn.length > 0) lines.push(`  TURN: ${turn.join(", ")}`);
  if (turn.length === 0) lines.push("  TURN: (none, peer-to-peer required)");
  lines.push(`  share_prompts:       ${sharePromptsEnabled() ? "on" : "off (default)"}`);
  if (signaling) lines.push(`  custom signaling:    ${signaling.join(", ")}`);
  lines.push("");
  lines.push("Live ICE probe:");
  for (const l of probeLines(probe, turnConfigured)) lines.push(l);
  lines.push("");
  lines.push("Recommended next step:");
  lines.push("  " + recommendation({
    wsl, wslMode, inRoom, mcpFound: sock.found,
    turnConfigured, probeRelay: probe.relay,
  }));
  exitWith(lines.join("\n"));
}

main().catch((e) => {
  process.stderr.write(`claude-rooms: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
