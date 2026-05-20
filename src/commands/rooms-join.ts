import { normalizeRoomCode } from "../room-code.js";
import { resolveActorName } from "../actor.js";
import { writeSessionState } from "../session-store.js";
import { getSessionId, ipcCall, exitWith } from "./_common.js";

interface RoomStatus {
  in_room: boolean;
  room_code?: string;
  me?: string;
  online_peer_count?: number;
  peer_actors?: Array<{ actor: string; online: boolean; focus?: string }>;
}

async function main(): Promise<void> {
  const sessionId = getSessionId();
  if (!sessionId) {
    exitWith("claude-rooms: CLAUDE_CODE_SESSION_ID is not set. Are you running inside Claude Code?", 1);
  }
  const arg = (process.argv[2] ?? "").trim();
  if (!arg) {
    exitWith("Usage: /rooms-join <code>. Example: /rooms-join kite-frog", 1);
  }
  const code = normalizeRoomCode(arg);
  if (!code) {
    exitWith(
      `claude-rooms: '${arg}' does not look like a room code.\n` +
      `Codes are two pronounceable words joined by '-', e.g. kite-frog or mint-anchor.`,
      1
    );
  }
  const actor = resolveActorName();
  writeSessionState(sessionId, {
    room_code: code,
    actor_name: actor,
    joined_at_ms: Date.now(),
  });

  // Prime the MCP server so the y-webrtc connection starts immediately.
  await ipcCall("room_status", { session_id: sessionId });

  // Brief poll for peers (up to 3s). y-webrtc takes a moment to discover
  // peers via the public signaling servers; this gives the user a more
  // useful message than "joined a room nobody is in."
  const startedAt = Date.now();
  let status: RoomStatus | null = null;
  while (Date.now() - startedAt < 3000) {
    status = await ipcCall<RoomStatus>("room_status", { session_id: sessionId });
    if (status && status.in_room && (status.online_peer_count ?? 0) > 0) break;
    await new Promise((res) => setTimeout(res, 250));
  }

  if (status && status.in_room && (status.online_peer_count ?? 0) > 0) {
    const others = (status.peer_actors ?? [])
      .filter((a) => a.online)
      .map((a) => a.actor)
      .join(", ");
    exitWith(
      `Joined room ${code} as ${actor}.\n` +
      `${status.online_peer_count} teammate${status.online_peer_count === 1 ? "" : "s"} online: ${others}.`
    );
  }

  exitWith(
    `Joined room ${code} as ${actor}.\n` +
    `Warning: no other teammates detected yet. ` +
    `Double-check the code with your friend, or wait a moment for the connection to settle.`
  );
}

main().catch((e) => {
  process.stderr.write(`claude-rooms: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
