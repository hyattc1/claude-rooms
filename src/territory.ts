// Glob matching for territory claims. Uses minimatch with gitignore-style
// patterns. Paths and globs are normalized to POSIX-forward-slash before
// matching.

import { minimatch } from "minimatch";

import type { TerritoryClaim } from "./shared-state.js";

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function matchAny(file: string, globs: string[]): boolean {
  const f = toPosix(file);
  for (const g of globs) {
    if (minimatch(f, toPosix(g), { matchBase: false, dot: true })) return true;
  }
  return false;
}

export interface OverlapHit {
  file: string;
  teammate: string;
  purpose: string;
}

export function findOverlaps(
  files: string[],
  teammates: Array<{ actor: string; territory: TerritoryClaim | null | undefined }>
): OverlapHit[] {
  const out: OverlapHit[] = [];
  for (const file of files) {
    for (const t of teammates) {
      if (!t.territory || !Array.isArray(t.territory.globs) || t.territory.globs.length === 0) continue;
      if (matchAny(file, t.territory.globs)) {
        out.push({ file, teammate: t.actor, purpose: t.territory.purpose });
      }
    }
  }
  return out;
}

export function isExpiredClaim(claim: TerritoryClaim, now = Date.now()): boolean {
  return now - claim.claimed_at_ms > claim.ttl_ms;
}
