// SessionStart hook: when a Claude Code session starts/resumes/clears,
// publish a full git refresh and inject the room's current teammate
// snapshot as additionalContext. If we are not in a room or MCP is
// unreachable, fail open: emit no context.

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { readSessionState } from "../session-store.js";
import {
  hookIpc,
  readStdinJson,
  emitHookOutput,
  inPlanMode,
  sharePromptsEnabled,
  warn,
} from "./_common.js";
import { readGitState } from "../git-state.js";

const SHARE_PROMPTS_HINT =
  "Note: prompt sharing is disabled by default for privacy. Teammates do not see what you ask Claude. Set share_prompts: true in the plugin config if you want them to.";

function pluginDataDir(): string {
  return process.env.CLAUDE_PLUGIN_DATA ?? "";
}

function hintMarkerPath(sessionId: string): string {
  return join(pluginDataDir(), "sessions", `${sessionId}.hint-shown`);
}

/** One-time per-session marker: if the file does not exist, returns true and
 *  writes the marker. Subsequent calls for the same session return false. */
function consumeFirstHintFlag(sessionId: string): boolean {
  if (!pluginDataDir() || !sessionId) return false;
  const p = hintMarkerPath(sessionId);
  if (existsSync(p)) return false;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(Date.now()), { encoding: "utf8", mode: 0o600 });
  } catch {
    // ignore; better to skip the hint than crash
  }
  return true;
}

interface ActorView {
  actor: string;
  focus: string;
  branch: string;
  online: boolean;
  files_open: string[];
  last_action: { type: string; summary?: string; timestamp_ms: number; files?: string[] } | null;
  recent_actions: Array<{ type: string; summary?: string }>;
  git?: {
    repo: string;
    branch: string;
    head: string;
    dirty: boolean;
    recent_commits: string[];
  } | null;
  plan?: {
    in_plan_mode: boolean;
    summary: string;
    steps_total: number;
    steps_done: number;
  } | null;
  last_prompt?: { text: string; at_ms: number } | null;
  territory?: { globs: string[]; purpose: string } | null;
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

function describeRepoRelation(me: ActorView | undefined, other: ActorView): string {
  if (!me?.git || !other.git) return "";
  const sameRepo = me.git.repo === other.git.repo;
  const sameBranch = me.git.branch === other.git.branch && me.git.branch.length > 0;
  if (sameRepo && sameBranch) return " (same branch as you, watch for conflicts)";
  if (sameRepo) return " (same repo, different branch)";
  return " (different repo, probably independent work)";
}

function formatTeammate(other: ActorView, me: ActorView | undefined): string {
  const status = other.online ? "online" : "offline";
  let head = `- ${other.actor} (${status})`;
  if (other.git) {
    head += ` in ${other.git.repo} on ${other.git.branch || "(no branch)"}${describeRepoRelation(me, other)}`;
  }
  const lines: string[] = [head];
  if (other.last_prompt && other.last_prompt.text) {
    lines.push(`  last prompt: "${other.last_prompt.text}"`);
  }
  if (other.focus) {
    lines.push(`  focus: ${other.focus}`);
  }
  if (other.plan && other.plan.summary) {
    lines.push(`  plan: ${other.plan.summary} (${other.plan.steps_done}/${other.plan.steps_total} done)`);
  } else if (other.plan && other.plan.in_plan_mode) {
    lines.push(`  plan: (in plan mode)`);
  }
  if (other.territory && other.territory.globs.length > 0) {
    lines.push(`  territory: ${other.territory.globs.join(", ")} (${other.territory.purpose})`);
  }
  if (other.last_action) {
    const s = other.last_action.summary ? ` - ${other.last_action.summary}` : "";
    lines.push(`  last action: ${other.last_action.type}${s}`);
  }
  if (other.files_open && other.files_open.length > 0) {
    lines.push(`  recent files: ${other.files_open.slice(-5).join(", ")}`);
  }
  return lines.join("\n");
}

function formatContext(snap: Snapshot): string {
  const me = snap.actors.find((a) => a.actor === snap.me);
  const others = snap.actors.filter((a) => a.actor !== snap.me);
  const teammateLines: string[] = [];
  if (others.length === 0) {
    teammateLines.push("No teammates currently online. The room is yours for now.");
  } else {
    for (const a of others) teammateLines.push(formatTeammate(a, me));
  }
  const lockLines = snap.locks.length === 0
    ? "No active file locks."
    : snap.locks.map((l) => `- ${l.file} (held by ${l.entry.actor})`).join("\n");

  const overlap = snap.territory_overlap ?? [];
  const overlapBlock = overlap.length === 0
    ? ""
    : "\n\nYour recent files overlap with teammate territory:\n" +
      overlap.map((o) => `- ${o.file} is in ${o.teammate}'s claimed territory ("${o.purpose}")`).join("\n");

  return (
    `## Room: ${snap.room_code}\n` +
    `\n` +
    `You are in a multiplayer Claude Code room. Other developers are running their own Claude Code sessions in the same room, and their agents share live state with yours.\n` +
    `\n` +
    `Teammates currently in this room:\n` +
    teammateLines.join("\n") +
    `\n\n` +
    `Active file locks:\n${lockLines}` +
    overlapBlock +
    `\n\n` +
    `Tools for staying in sync:\n` +
    `- read_room_state: fast local query of all teammate state. Call before any meaningful unit of work.\n` +
    `- update_my_focus: tell teammates what you are working on.\n` +
    `- update_my_plan: when you have a multi-step plan, share the summary and progress.\n` +
    `- claim_territory: declare which directories or files you intend to work in. Call before substantial tasks.\n` +
    `- release_territory: clear your claim when finished or shifting focus.\n` +
    `\n` +
    `Coordination model:\n` +
    `- Soft layer: territory claims help teammates route around your work at the planning stage.\n` +
    `- Hard layer: file locks block direct conflicts at the edit stage.\n` +
    `- When you start a task that will touch more than a couple of files, call claim_territory first.\n` +
    `- When the user asks you to work on something, call read_room_state to check teammate territories before planning. If your task overlaps a teammate's territory, surface it to the user.\n` +
    `\n` +
    `The room is live: teammate state updates continuously during your turn. Use read_room_state during your work whenever you suspect a teammate's situation has changed.`
  );
}

async function main(): Promise<void> {
  const input = readStdinJson();
  const sessionId = input.session_id ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) return; // fail open

  const local = readSessionState(sessionId);
  if (!local) return; // not in a room

  // v1.1: publish a full git refresh and the plan-mode flag up-front.
  const cwd = input.cwd ?? process.cwd();
  const git = readGitState(cwd, { includeCommits: true });
  await hookIpc(
    "update_my_git",
    { session_id: sessionId, state: git, include_commits: true },
    sessionId
  );
  await hookIpc(
    "update_my_plan",
    { session_id: sessionId, in_plan_mode: inPlanMode(input) },
    sessionId
  );

  const resp = await hookIpc<GetStateResp>("get_state", { session_id: sessionId }, sessionId);
  // Compute the optional first-session hint about share_prompts being off.
  const hint = !sharePromptsEnabled() && consumeFirstHintFlag(sessionId)
    ? `\n\n${SHARE_PROMPTS_HINT}`
    : "";

  if (!resp || !resp.in_room || !resp.snapshot) {
    emitHookOutput({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          `## Room: ${local.room_code}\nYou are in claude-rooms as ${local.actor_name}. Teammate state will appear once the MCP server connects. Call read_room_state during your turn for the latest.${hint}`,
      },
    });
    return;
  }
  const text = formatContext(resp.snapshot) + hint;
  emitHookOutput({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: text,
    },
  });
}

main().catch((e) => {
  warn(`session-start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0); // fail open
});
