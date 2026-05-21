// Detect WSL2 and infer whether its networking is the default NAT mode or
// the Win11-22H2+ mirrored mode. Used by rooms-doctor, /rooms-status, and
// the SessionStart one-time hint.

import { readFileSync } from "node:fs";

let wslCache: boolean | null = null;

/** True when running inside WSL (any version). Reads /proc/version once and
 *  caches the result; returns false on non-Linux hosts or read errors. */
export function isWSL(): boolean {
  if (wslCache !== null) return wslCache;
  try {
    const v = readFileSync("/proc/version", "utf8");
    wslCache = /microsoft|wsl/i.test(v);
  } catch {
    wslCache = false;
  }
  return wslCache;
}

/** For testing only. Resets the isWSL() cache so a test can swap /proc/version
 *  via a stub. Not called in production. */
export function _resetWSLCache(): void {
  wslCache = null;
}

/** Parses a kernel-format little-endian hex IP (as found in /proc/net/route)
 *  and returns dotted-decimal. Returns "" on parse error. */
export function parseKernelHexIp(hex: string): string {
  if (!/^[0-9A-Fa-f]{8}$/.test(hex)) return "";
  const b0 = parseInt(hex.slice(0, 2), 16);
  const b1 = parseInt(hex.slice(2, 4), 16);
  const b2 = parseInt(hex.slice(4, 6), 16);
  const b3 = parseInt(hex.slice(6, 8), 16);
  // /proc/net/route stores the address as a little-endian u32, so the
  // dotted-decimal bytes are the hex pairs in reverse.
  return `${b3}.${b2}.${b1}.${b0}`;
}

/** Returns the default-route gateway IP from /proc/net/route, or "" on error. */
export function readDefaultGateway(): string {
  let raw: string;
  try {
    raw = readFileSync("/proc/net/route", "utf8");
  } catch {
    return "";
  }
  const lines = raw.split("\n");
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    // Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
    if (cols.length < 4) continue;
    const dest = cols[1];
    const gw = cols[2];
    const flags = parseInt(cols[3], 16);
    if (dest !== "00000000") continue;
    if (Number.isNaN(flags) || (flags & 0x2) === 0) continue;
    const ip = parseKernelHexIp(gw);
    if (ip) return ip;
  }
  return "";
}

/** True when ip is inside 172.16.0.0/12 (the WSL2 NAT subnet). */
export function isWslNatGateway(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a !== 172) return false;
  return b >= 16 && b <= 31;
}

/** Returns the inferred WSL2 networking mode.
 *  - "nat": default WSL2 NAT subnet (172.16.0.0/12). Inbound UDP blocked.
 *  - "mirrored": gateway is the host's actual LAN router. Direct WebRTC works.
 *  - "unknown": cannot determine (not WSL, or /proc files unreadable, or
 *               gateway IP outside the expected ranges). Callers should
 *               treat "unknown" as "do not show a NAT warning". */
export function wslNetworkingMode(): "mirrored" | "nat" | "unknown" {
  if (!isWSL()) return "unknown";
  const gw = readDefaultGateway();
  if (!gw) return "unknown";
  if (isWslNatGateway(gw)) return "nat";
  return "mirrored";
}
