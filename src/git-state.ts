// Local git inspection for the actor's current working state. All shell-outs
// are short-timeout and never fail a hook: any error or non-repo cwd returns
// null and the caller treats git information as absent.

import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export interface GitState {
  repo: string;
  branch: string;
  head: string;
  dirty: boolean;
  recent_commits: string[];
}

interface ReadOpts {
  /** Skip `git log` (5x faster). Default false. */
  includeCommits?: boolean;
}

function tryRun(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 800,
    });
  } catch {
    return null;
  }
}

function inferRepoName(cwd: string): string {
  const remote = tryRun(["config", "--get", "remote.origin.url"], cwd);
  if (remote) {
    // Strip protocol/host, take last path segment, drop .git.
    const trimmed = remote.trim().replace(/\.git$/, "");
    const seg = trimmed.split(/[\/:]/).filter(Boolean).pop();
    if (seg) return seg;
  }
  return basename(cwd) || "(unknown)";
}

export function readGitState(cwd: string, opts: ReadOpts = {}): GitState | null {
  // The canonical "is this a git repo" check.
  const head = tryRun(["rev-parse", "--short", "HEAD"], cwd);
  if (!head) return null;

  const branch = (tryRun(["branch", "--show-current"], cwd) ?? "").trim();
  const status = tryRun(["status", "--porcelain"], cwd);
  const dirty = (status ?? "").trim().length > 0;
  const repo = inferRepoName(cwd);

  let recent_commits: string[] = [];
  if (opts.includeCommits) {
    const log = tryRun(["log", "-5", "--format=%s", "--no-color"], cwd);
    if (log) {
      // git log prints newest first; reverse so oldest is last (per plan).
      recent_commits = log.split("\n").map((l) => l.trim()).filter(Boolean).reverse();
    }
  }

  return {
    repo,
    branch,
    head: head.trim(),
    dirty,
    recent_commits,
  };
}

/** Convenience for hooks: lightweight call that omits commits. */
export function readGitStateLight(cwd: string): GitState | null {
  return readGitState(cwd, { includeCommits: false });
}
