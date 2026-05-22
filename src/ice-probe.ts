// Live ICE candidate probe. Opens a one-shot RTCPeerConnection with the
// supplied iceServers, gathers candidates for a bounded budget, then closes.
// Used by /rooms-doctor to report whether your TURN config actually issues
// a `relay` candidate; without this signal, users have no way to tell if
// their config is dead weight.
//
// Important: this is best-effort. Failures (no wrtc binary, network down,
// servers unreachable) return an empty result rather than throwing.

import wrtc from "@roamhq/wrtc";
import type { IceServer } from "./ice-servers.js";

export interface IceProbeResult {
  ok: boolean;
  /** Distinct candidate types seen during gathering. "host", "srflx", "prflx", "relay". */
  types: string[];
  /** True iff at least one relay candidate was issued by a TURN server. */
  relay: boolean;
  /** Public IPv4 inferred from the first srflx candidate, useful for users
   *  who want to know what STUN saw. Empty when none. */
  public_ip: string;
  /** Milliseconds elapsed during gathering. */
  elapsed_ms: number;
  /** Optional error message if construction failed entirely. */
  error?: string;
}

/** Run a bounded ICE candidate gathering pass and report what came back.
 *  budgetMs caps how long we wait; defaults to 6s which is enough to
 *  produce a relay candidate from a healthy TURN server while not making
 *  /rooms-doctor feel slow. */
export async function probeIce(
  iceServers: readonly IceServer[],
  budgetMs = 6000
): Promise<IceProbeResult> {
  const started = Date.now();
  const result: IceProbeResult = {
    ok: false,
    types: [],
    relay: false,
    public_ip: "",
    elapsed_ms: 0,
  };
  let pc: RTCPeerConnection;
  try {
    pc = new wrtc.RTCPeerConnection({ iceServers: iceServers as IceServer[] });
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    result.elapsed_ms = Date.now() - started;
    return result;
  }

  const types = new Set<string>();
  let publicIp = "";

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    pc.onicecandidate = (e: RTCPeerConnectionIceEvent) => {
      if (!e.candidate) { finish(); return; }
      const c = e.candidate.candidate ?? "";
      const m = /typ (\w+)/.exec(c);
      if (m) types.add(m[1]);
      const srflxIp = /typ srflx raddr \S+ rport \d+ generation \d+/.exec(c)
        ? /^candidate:\S+ \S+ \S+ \S+ (\S+) \S+/.exec(c)?.[1]
        : null;
      if (!publicIp && srflxIp) publicIp = srflxIp;
    };
    pc.createDataChannel("probe");
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => finish());
    setTimeout(finish, budgetMs);
  });

  try { pc.close(); } catch { /* ignore */ }
  result.ok = true;
  result.types = [...types].sort();
  result.relay = types.has("relay");
  result.public_ip = publicIp;
  result.elapsed_ms = Date.now() - started;
  return result;
}
