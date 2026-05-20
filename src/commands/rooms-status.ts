import { readSessionState } from "../session-store.js";
import { getSessionId, ipcCall, exitWith } from "./_common.js";

interface ActorLite {
  actor: string;
  focus: string;
  branch: string;
  online: boolean;
  files_open: string[];
  last_action: { type: string; summary?: string; timestamp_ms: number } | null;
}

interface Snapshot {
  room_code: string;
  me: string;
  actors: ActorLite[];
  locks: Array<{ file: string; entry: { actor: string } }>;
  online_peer_count: number;
}

interface GetStateResp {
  in_room: boolean;
  snapshot?: Snapshot;
}

async function main(): Promise<void> {
  const sessionId = getSessionId();
  if (!sessionId) {
    exitWith("claude-rooms: CLAUDE_CODE_SESSION_ID is not set. Are you running inside Claude Code?", 1);
  }
  const localState = readSessionState(sessionId);
  if (!localState) {
    exitWith("Not currently in a room. Use /rooms-create or /rooms-join <code> to start one.");
  }

  const resp = await ipcCall<GetStateResp>("get_state", { session_id: sessionId });
  if (!resp || !resp.in_room || !resp.snapshot) {
    exitWith(
      `Room: ${localState.room_code}\n` +
      `You: ${localState.actor_name}\n` +
      `MCP server not reachable; teammate state unavailable.`
    );
  }
  const s = resp.snapshot;
  const me = s.actors.find((a) => a.actor === s.me);
  const others = s.actors.filter((a) => a.actor !== s.me);
  const lines: string[] = [];
  lines.push(`Room: ${s.room_code}`);
  lines.push(`You: ${s.me} (online)${me && me.focus ? ` - focus: ${me.focus}` : ""}`);
  lines.push("");
  if (others.length === 0) {
    lines.push("Teammates: none online.");
  } else {
    lines.push("Teammates:");
    for (const a of others) {
      const status = a.online ? "online" : "offline";
      const focusPart = a.focus ? ` - focus: ${a.focus}` : "";
      const branchPart = a.branch ? ` (branch ${a.branch})` : "";
      const lastPart = a.last_action
        ? ` - last: ${a.last_action.type}${a.last_action.summary ? " (" + a.last_action.summary + ")" : ""}`
        : "";
      lines.push(`  ${a.actor} (${status})${branchPart}${focusPart}${lastPart}`);
    }
  }
  lines.push("");
  if (s.locks.length === 0) {
    lines.push("Locks held: none.");
  } else {
    lines.push("Locks held:");
    for (const l of s.locks) {
      lines.push(`  ${l.file} (${l.entry.actor})`);
    }
  }
  exitWith(lines.join("\n"));
}

main().catch((e) => {
  process.stderr.write(`claude-rooms: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
