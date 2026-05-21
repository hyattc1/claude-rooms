// ICE-server resolution for the WebRTC peer connection. Reads userConfig env
// vars and falls back to a sane default that pierces most restrictive NATs
// (including WSL2's default NAT mode) without anyone setting up an account.
//
// Resolution order:
//   1. STUN entries from DEFAULT_ICE always present (free, no auth, anonymous).
//   2. TURN entries: either user-provided via CLAUDE_PLUGIN_OPTION_TURN_SERVERS,
//      or the Open Relay default, unless CLAUDE_PLUGIN_OPTION_DISABLE_DEFAULT_TURN
//      is truthy.
//
// The default TURN endpoint is Open Relay's long-standing anonymous endpoint
// widely used in OSS projects (20 GB per IP per month free). Power users
// pinned to a private coturn can override via userConfig.

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const DEFAULT_STUN: IceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const DEFAULT_OPEN_RELAY_TURN: IceServer = {
  urls: [
    "turn:openrelay.metered.ca:80",
    "turn:openrelay.metered.ca:443",
    "turns:openrelay.metered.ca:443?transport=tcp",
  ],
  username: "openrelayproject",
  credential: "openrelayproject",
};

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
      "claude-rooms: CLAUDE_PLUGIN_OPTION_TURN_SERVERS is not valid JSON; using default TURN.\n"
    );
    return null;
  }
  if (!Array.isArray(parsed)) {
    process.stderr.write(
      "claude-rooms: CLAUDE_PLUGIN_OPTION_TURN_SERVERS must be a JSON array; using default TURN.\n"
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
      "claude-rooms: CLAUDE_PLUGIN_OPTION_TURN_SERVERS parsed but contained no valid RTCIceServer entries; using default TURN.\n"
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
 *  The result is a fresh frozen array so callers cannot mutate the shared config. */
export function resolveIceServers(): readonly IceServer[] {
  const userTurn = parseUserTurnServers(process.env.CLAUDE_PLUGIN_OPTION_TURN_SERVERS);
  const disableDefaultTurn = isTruthyFlag(process.env.CLAUDE_PLUGIN_OPTION_DISABLE_DEFAULT_TURN);
  const out: IceServer[] = [...DEFAULT_STUN];
  if (userTurn) {
    out.push(...userTurn);
  } else if (!disableDefaultTurn) {
    out.push({ ...DEFAULT_OPEN_RELAY_TURN });
  }
  return Object.freeze(out);
}

/** Optional override for y-webrtc signaling. Returns null when no override
 *  is set, so callers can omit the property and y-webrtc uses its baked-in
 *  community defaults. */
export function resolveSignalingServers(): string[] | null {
  return parseUserSignalingServers(process.env.CLAUDE_PLUGIN_OPTION_SIGNALING_SERVERS);
}

/** Short single-line description of the resolved ICE config, suitable for
 *  /rooms-status and /rooms-doctor output. Shape:
 *    "2 STUN + 1 TURN (Open Relay)" or "2 STUN + 1 TURN (custom)" or "2 STUN, no TURN" */
export function summarizeIceServers(servers: readonly IceServer[]): string {
  let stunCount = 0;
  let turnCount = 0;
  let sawOpenRelay = false;
  let sawCustomTurn = false;
  for (const s of servers) {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    for (const u of urls) {
      if (u.startsWith("stun:")) stunCount += 1;
      else if (u.startsWith("turn:") || u.startsWith("turns:")) {
        turnCount += 1;
        if (u.includes("openrelay.metered.ca")) sawOpenRelay = true;
        else sawCustomTurn = true;
      }
    }
  }
  if (turnCount === 0) return `${stunCount} STUN, no TURN`;
  const label = sawOpenRelay && !sawCustomTurn
    ? "Open Relay"
    : sawCustomTurn && !sawOpenRelay
    ? "custom"
    : "mixed";
  return `${stunCount} STUN + ${turnCount} TURN (${label})`;
}

/** Exported for tests so they can compare against the live default value. */
export const _DEFAULT_OPEN_RELAY_TURN = DEFAULT_OPEN_RELAY_TURN;
export const _DEFAULT_STUN = DEFAULT_STUN;
