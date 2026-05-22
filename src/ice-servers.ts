// ICE-server resolution for the WebRTC peer connection. Reads userConfig env
// vars; default config is STUN-only.
//
// v1.2 originally shipped Open Relay's anonymous public TURN endpoint as a
// default fallback. Live probing showed that endpoint no longer issues
// `relay` candidates (the freely-pasted credentials are effectively
// rate-limited or rejected). Rather than ship a fallback that silently
// fails, the default is now STUN-only: direct peer-to-peer must succeed.
// Users on restrictive networks (WSL2 NAT, symmetric NATs, locked-down
// corporate firewalls) can configure their own TURN via the
// `turn_servers` userConfig (self-hosted coturn, Cloudflare TURN, paid
// Metered tier, Twilio NTS, etc.). /rooms-doctor runs a live ICE probe
// and reports whether your config actually produces a relay candidate, so
// dead-weight TURN entries are visible.

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const DEFAULT_STUN: IceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

function isTruthyFlag(v: string | undefined): boolean {
  if (v == null) return false;
  const s = v.trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function parseUserTurnServers(raw: string | undefined): IceServer[] | null {
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(
      "claude-rooms: CLAUDE_PLUGIN_OPTION_TURN_SERVERS is not valid JSON; ignoring.\n"
    );
    return null;
  }
  if (!Array.isArray(parsed)) {
    process.stderr.write(
      "claude-rooms: CLAUDE_PLUGIN_OPTION_TURN_SERVERS must be a JSON array; ignoring.\n"
    );
    return null;
  }
  const out: IceServer[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { urls?: unknown; username?: unknown; credential?: unknown };
    if (typeof e.urls !== "string" && !(Array.isArray(e.urls) && e.urls.every((u) => typeof u === "string"))) {
      continue;
    }
    const server: IceServer = { urls: e.urls as string | string[] };
    if (typeof e.username === "string") server.username = e.username;
    if (typeof e.credential === "string") server.credential = e.credential;
    out.push(server);
  }
  if (out.length === 0) {
    process.stderr.write(
      "claude-rooms: CLAUDE_PLUGIN_OPTION_TURN_SERVERS parsed but contained no valid RTCIceServer entries; ignoring.\n"
    );
    return null;
  }
  return out;
}

function parseUserSignalingServers(raw: string | undefined): string[] | null {
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(
      "claude-rooms: CLAUDE_PLUGIN_OPTION_SIGNALING_SERVERS is not valid JSON; using y-webrtc defaults.\n"
    );
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every((u) => typeof u === "string")) {
    process.stderr.write(
      "claude-rooms: CLAUDE_PLUGIN_OPTION_SIGNALING_SERVERS must be a JSON array of strings; using y-webrtc defaults.\n"
    );
    return null;
  }
  const arr = parsed as string[];
  if (arr.length === 0) return null;
  return arr;
}

/** Returns the ICE-server list to hand to simple-peer via peerOpts.config.iceServers.
 *  Default is STUN-only. TURN entries come from CLAUDE_PLUGIN_OPTION_TURN_SERVERS
 *  when provided. The result is a frozen array. */
export function resolveIceServers(): readonly IceServer[] {
  const userTurn = parseUserTurnServers(process.env.CLAUDE_PLUGIN_OPTION_TURN_SERVERS);
  const out: IceServer[] = [...DEFAULT_STUN];
  if (userTurn) out.push(...userTurn);
  return Object.freeze(out);
}

/** True if the user has configured at least one TURN entry. Used by the
 *  doctor's recommendation logic. */
export function userTurnConfigured(): boolean {
  return parseUserTurnServers(process.env.CLAUDE_PLUGIN_OPTION_TURN_SERVERS) !== null;
}

/** Optional override for y-webrtc signaling. Returns null when no override
 *  is set, so callers can omit the property and y-webrtc uses its baked-in
 *  community defaults. */
export function resolveSignalingServers(): string[] | null {
  return parseUserSignalingServers(process.env.CLAUDE_PLUGIN_OPTION_SIGNALING_SERVERS);
}

/** Short single-line description of the resolved ICE config. */
export function summarizeIceServers(servers: readonly IceServer[]): string {
  let stunCount = 0;
  let turnCount = 0;
  for (const s of servers) {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    for (const u of urls) {
      if (u.startsWith("stun:")) stunCount += 1;
      else if (u.startsWith("turn:") || u.startsWith("turns:")) turnCount += 1;
    }
  }
  if (turnCount === 0) return `${stunCount} STUN, no TURN (direct P2P only)`;
  return `${stunCount} STUN + ${turnCount} TURN (user-configured)`;
}

/** Exported for tests. */
export const _DEFAULT_STUN = DEFAULT_STUN;
