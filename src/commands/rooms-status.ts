import { readSessionState } from "../session-store.js";
import { readGitState } from "../git-state.js";
import { sharePromptsEnabled } from "../hooks/_common.js";
import { resolveIceServers, summarizeIceServers } from "../ice-servers.js";
import { isWSL, wslNetworkingMode } from "../wsl-detect.js";
import { getSessionId, ipcCall, exitWith } from "./_common.js";

interface GitView {
  repo: string;
  branch: string;
  head: string;
  dirty: boolean;
  recent_commits: string[];
}

interface PlanView {
  in_plan_mode: boolean;
  summary: string;
  steps_total: number;
  steps_done: number;
}

interface ActorView {
  actor: string;
  focus: string;
  branch: string;
  online: boolean;
  files_open: string[];
  last_action: { type: string; summary?: string; files?: string[]; timestamp_ms: number } | null;
  git?: GitView | null;
  plan?: PlanView | null;
  last_prompt?: { text: string; at_ms: number } | null;
  territory?: { globs: string[]; purpose: string } | null;
  redactions_count?: number;
}

interface Snapshot {
  schema_version?: number;
  room_code: string;
  me: string;
  actors: ActorView[];
  locks: Array<{ file: string; entry: { actor: string } }>;
  online_peer_count: number;
  territory_overlap?: Array<{ file: string; teammate: string; purpose: string }>;
}

interface GetStateResp {
  in_room: boolean;
  snapshot?: Snapshot;
}

function gitSummary(git: GitView | null | undefined): string {
  if (!git) return "";
  const dirty = git.dirty ? "uncommitted" : "clean";
  return ` - ${git.repo} on ${git.branch || "(no branch)"} at ${git.head} (${dirty})`;
}

function planLine(plan: PlanView | null | undefined): string | null {
  if (!plan) return null;
  if (plan.summary) {
    return `plan: ${plan.summary} (${plan.steps_done}/${plan.steps_total} done)`;
  }
  if (plan.in_plan_mode) return `plan: (in plan mode)`;
  return null;
}

function teammateBlock(a: ActorView): string[] {
  const lines: string[] = [];
  const status = a.online ? "online" : "offline";
  lines.push(`  ${a.actor} (${status})${gitSummary(a.git)}`);
  const sub = "    ";
  if (a.last_prompt && a.last_prompt.text) {
    lines.push(`${sub}last prompt: "${a.last_prompt.text}"`);
  }
  if (a.focus) lines.push(`${sub}focus: ${a.focus}`);
  const pl = planLine(a.plan);
  if (pl) lines.push(`${sub}${pl}`);
  if (a.territory && a.territory.globs.length > 0) {
    lines.push(`${sub}territory: ${a.territory.globs.join(", ")} (${a.territory.purpose})`);
  }
  if (a.last_action) {
    const fileBit = a.last_action.files && a.last_action.files[0]
      ? ` ${a.last_action.files[0]}`
      : (a.last_action.summary ? ` ${a.last_action.summary}` : "");
    lines.push(`${sub}last edit:${fileBit}`);
  }
  return lines;
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

  // Best-effort: push a fresh local git state to MCP so the rendered status
  // reflects reality even if hooks have not fired recently.
  const cwd = process.cwd();
  const git = readGitState(cwd, { includeCommits: false });
  await ipcCall("update_my_git", { session_id: sessionId, state: git, include_commits: false });

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

  // "You" block.
  if (me) {
    const focusPart = me.focus ? ` - focus: ${me.focus}` : "";
    lines.push(`You: ${s.me} (online)${gitSummary(me.git)}${focusPart}`);
    const pl = planLine(me.plan);
    if (pl) lines.push(`  ${pl}`);
    if (me.territory && me.territory.globs.length > 0) {
      lines.push(`  territory: ${me.territory.globs.join(", ")} (${me.territory.purpose})`);
    }
    // v1.2: one-line ICE summary so users can see how their WebRTC is wired up.
    lines.push(`  ICE: ${summarizeIceServers(resolveIceServers())}`);
    // v1.2: WSL2 NAT warning. Mirrored mode is silent (works fine).
    if (isWSL() && wslNetworkingMode() === "nat") {
      lines.push("  WSL2 NAT mode detected: cross-machine sync requires mirrored mode or a working TURN. Run /claude-rooms:rooms-doctor for the diagnostic.");
    }
    // v1.1: privacy hint when prompt sharing is off (default).
    if (!sharePromptsEnabled()) {
      lines.push("  (prompt sharing disabled by default. Enable in plugin config to share prompts with teammates.)");
    }
    // v1.1: surface the redaction counter when nonzero so the protection is visible.
    if (typeof me.redactions_count === "number" && me.redactions_count > 0) {
      const n = me.redactions_count;
      lines.push(`  ${n} likely secret${n === 1 ? "" : "s"} auto-redacted from your shared state this session.`);
    }
  } else {
    lines.push(`You: ${s.me} (online)`);
  }

  lines.push("");
  if (others.length === 0) {
    lines.push("Teammates: none online.");
  } else {
    lines.push("Teammates:");
    for (const a of others) {
      lines.push(...teammateBlock(a));
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

  if (s.territory_overlap && s.territory_overlap.length > 0) {
    lines.push("");
    for (const o of s.territory_overlap) {
      lines.push(
        `Warning: ${o.file} (you have recently edited) is in ${o.teammate}'s claimed territory ("${o.purpose}").`
      );
    }
  }
  exitWith(lines.join("\n"));
}

main().catch((e) => {
  process.stderr.write(`claude-rooms: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
