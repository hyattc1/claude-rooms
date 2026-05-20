import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const ACTOR_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

export function kebabize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function randomFallback(): string {
  const r = randomBytes(4).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
  return `host-${r || "anon"}`;
}

function tryGitUserName(): string | null {
  try {
    const out = execFileSync("git", ["config", "--get", "user.name"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
    const kebabed = kebabize(out);
    return kebabed.length >= 2 ? kebabed : null;
  } catch {
    return null;
  }
}

// Resolution order: CLAUDE_PLUGIN_OPTION_ACTOR_NAME, then git user.name kebab-cased,
// then a random host-<6chars> fallback.
export function resolveActorName(): string {
  const fromConfig = process.env.CLAUDE_PLUGIN_OPTION_ACTOR_NAME;
  if (fromConfig) {
    const k = kebabize(fromConfig);
    if (k.length >= 2 && ACTOR_NAME_RE.test(k)) return k;
  }
  const fromGit = tryGitUserName();
  if (fromGit && ACTOR_NAME_RE.test(fromGit)) return fromGit;
  return randomFallback();
}
