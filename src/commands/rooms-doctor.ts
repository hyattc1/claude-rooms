// /claude-rooms:rooms-doctor
//
// Self-debug page. Runs without needing to be in a room. Prints WSL status,
// ICE configuration, MCP socket discovery, current room (if any), and a
// recommended next step. Never modifies state.

import { discoverSocketPath, discoverAnyAliveSocket } from "../ipc.js";
import { readSessionState } from "../session-store.js";
import { sharePromptsEnabled } from "../hooks/_common.js";
import { resolveIceServers, resolveSignalingServers, summarizeIceServers } from "../ice-servers.js";
import { isWSL, wslNetworkingMode, readDefaultGateway } from "../wsl-detect.js";
import { getSessionId, exitWith } from "./_common.js";

function isTruthyFlag(v: string | undefined): boolean {
  if (v == null) return false;
  const s = v.trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

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
}): string {
  if (!args.mcpFound) {
    return "MCP server not reachable. Restart Claude Code and re-run this command. If the issue persists, the plugin may need to be reinstalled.";
  }
  if (args.wsl && args.wslMode === "nat") {
    const urgency = args.inRoom
      ? "You are in a room and WSL2 NAT mode may be silently failing peer-to-peer. Enable mirrored mode on Windows 11 22H2+ for direct connections; until then, public TURN relay is active by default."
      : "Enable WSL2 mirrored mode (see README) for direct peer-to-peer. Until then, public TURN relay is active by default and connections still work, just slower.";
    return urgency;
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

function main(): void {
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
  const disableDefaultTurn = isTruthyFlag(process.env.CLAUDE_PLUGIN_OPTION_DISABLE_DEFAULT_TURN);
  const customTurn = !!process.env.CLAUDE_PLUGIN_OPTION_TURN_SERVERS;

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
  lines.push(`  disable_default_turn: ${disableDefaultTurn ? "yes" : "no"}`);
  lines.push(`  custom turn_servers: ${customTurn ? "yes" : "no"}`);
  if (signaling) lines.push(`  custom signaling:    ${signaling.join(", ")}`);
  lines.push("");
  lines.push("Recommended next step:");
  lines.push("  " + recommendation({ wsl, wslMode, inRoom, mcpFound: sock.found }));
  exitWith(lines.join("\n"));
}

try {
  main();
} catch (e) {
  process.stderr.write(`claude-rooms: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
