// The y-webrtc-backed shared state. Owned by the MCP server process; hooks
// and slash commands talk to it over IPC, never directly.
//
// Schema (lives inside one Y.Doc per room):
//   ydoc.getMap('actors'): Y.Map<actorName, ActorState>
//   ydoc.getMap('locks'):  Y.Map<filePath,  LockEntry>
//
// Awareness carries the {actor: actorName} field per peer so disconnects can
// be mapped from clientID back to actor and reaped.
//
// All mutating ops happen inside ydoc.transact() so concurrent updates from
// peers converge deterministically through Yjs CRDT linearization.

import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import { Awareness } from "y-protocols/awareness";

// Node WebRTC backend. y-webrtc/simple-peer use the browser WebRTC API by
// default; in Node we must inject @roamhq/wrtc via peerOpts.
import wrtc from "@roamhq/wrtc";

export interface ActionEvent {
  type: string;
  files?: string[];
  summary?: string;
  timestamp_ms: number;
  // Optional payload for room-internal events like stale_lock_reclaimed_by_other.
  details?: Record<string, unknown>;
}

export interface GitState {
  repo: string;
  branch: string;
  head: string;
  dirty: boolean;
  recent_commits: string[];
}

export interface PlanState {
  in_plan_mode: boolean;
  summary: string;
  steps_total: number;
  steps_done: number;
  updated_at_ms: number;
}

export interface LastPromptState {
  text: string;
  at_ms: number;
}

export interface TerritoryClaim {
  globs: string[];
  purpose: string;
  claimed_at_ms: number;
  ttl_ms: number;
}

export interface ActorState {
  actor: string;
  focus: string;
  branch: string;
  files_open: string[];
  last_action: ActionEvent | null;
  recent_actions: ActionEvent[];
  blockers: string[];
  online: boolean;
  last_heartbeat_ms: number;
  // v1.1 additive fields. Optional for cross-version graceful degradation.
  git?: GitState | null;
  plan?: PlanState | null;
  last_prompt?: LastPromptState | null;
}

/** Snapshot-only: territory is stored in a separate Y.Map so its TTL can be
 *  handled without rewriting the whole actor record, but the snapshot joins
 *  it into the per-actor view for downstream consumers. */
export interface ActorStateView extends ActorState {
  territory?: TerritoryClaim | null;
}

export interface LockEntry {
  actor: string;
  acquired_at_ms: number;
  ttl_ms: number;
}

export const DEFAULT_LOCK_TTL_MS = 60 * 60 * 1000; // 60 minutes
export const SET_MY_STATE_DEBOUNCE_MS = 250;
export const RECENT_ACTIONS_CAP = 10;

export const SCHEMA_VERSION = 2;
export const DEFAULT_TERRITORY_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
export const GIT_FULL_REFRESH_MIN_INTERVAL_MS = 5000;

export interface TerritoryOverlap {
  file: string;
  teammate: string;
  purpose: string;
}

export interface RoomSnapshot {
  schema_version: number;
  room_code: string;
  me: string;
  actors: ActorStateView[];
  locks: Array<{ file: string; entry: LockEntry }>;
  online_peer_count: number;
  /** Files this actor has touched recently that fall inside any teammate's
   *  active territory. Empty array when none. */
  territory_overlap: TerritoryOverlap[];
}

export interface TryAcquireResult {
  ok: boolean;
  held?: Array<{ file: string; actor: string }>;
}

import { findOverlaps } from "./territory.js";

export class Room {
  readonly roomCode: string;
  readonly me: string;
  private ydoc: Y.Doc;
  private provider: WebrtcProvider | null = null;
  private awareness: Awareness | null = null;
  private actors!: Y.Map<ActorState>;
  private locks!: Y.Map<LockEntry>;
  private events!: Y.Map<unknown>; // reserved for room-level events; unused in v1
  private territories!: Y.Map<TerritoryClaim>;
  private meta!: Y.Map<unknown>;
  private pendingPatch: Partial<ActorState> | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private lockTtlMs: number;
  /** Most-recent full git refresh times per actor, for the 5s throttle. */
  private lastFullGitRefreshMs = 0;

  constructor(roomCode: string, me: string, opts: { lockTtlMs?: number; ydoc?: Y.Doc } = {}) {
    this.roomCode = roomCode;
    this.me = me;
    this.lockTtlMs = opts.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    this.ydoc = opts.ydoc ?? new Y.Doc();
    this.actors = this.ydoc.getMap<ActorState>("actors");
    this.locks = this.ydoc.getMap<LockEntry>("locks");
    this.events = this.ydoc.getMap("events");
    this.territories = this.ydoc.getMap<TerritoryClaim>("territories");
    this.meta = this.ydoc.getMap("meta");
    // Schema-version handshake. New clients bump the version if missing or
    // older than what they understand; old clients ignore the meta map.
    this.ydoc.transact(() => {
      const cur = this.meta.get("schema_version");
      if (typeof cur !== "number" || cur < SCHEMA_VERSION) {
        this.meta.set("schema_version", SCHEMA_VERSION);
      }
    });
  }

  /**
   * Start a y-webrtc connection. Lazy-called by the MCP server on the first
   * room-related operation.
   *
   * If opts.testMode is true (used by smoke tests and unit tests), the room
   * uses an in-process awareness instance only and skips the WebRTC provider.
   * Tests share state by manipulating the Y.Doc directly across instances.
   */
  connect(opts: { testMode?: boolean; signaling?: string[] } = {}): void {
    if (this.provider || this.destroyed) return;
    if (opts.testMode) {
      // In testMode, skip the WebRTC provider AND the Awareness instance.
      // Awareness has a 15s heartbeat timer that keeps the Node event loop
      // alive; in unit tests we exercise lock/state logic via shared Y.Docs
      // and verify awareness-based reaping in the real-session tests.
      this.ensureSelfActorRecord();
      return;
    }
    this.provider = new WebrtcProvider(this.roomCode, this.ydoc, {
      signaling: opts.signaling,
      peerOpts: { wrtc },
      filterBcConns: false,
    } as ConstructorParameters<typeof WebrtcProvider>[2]);
    this.awareness = this.provider.awareness;
    this.awareness.setLocalStateField("actor", this.me);
    this.wireAwarenessLockReaper();
    this.ensureSelfActorRecord();
  }

  private ensureSelfActorRecord(): void {
    if (this.actors.has(this.me)) return;
    const now = Date.now();
    const initial: ActorState = {
      actor: this.me,
      focus: "",
      branch: "",
      files_open: [],
      last_action: null,
      recent_actions: [],
      blockers: [],
      online: true,
      last_heartbeat_ms: now,
    };
    this.ydoc.transact(() => {
      this.actors.set(this.me, initial);
    });
  }

  /** Map awareness clientIDs to actor names so we can reap on disconnect. */
  private wireAwarenessLockReaper(): void {
    if (!this.awareness) return;
    const aw = this.awareness;
    aw.on("change", (delta: { added: number[]; updated: number[]; removed: number[] }) => {
      if (delta.removed.length === 0) return;
      const departed = new Set<string>();
      // Build actor map from current awareness states. The departed clients are
      // already gone from the map, so we rely on having captured their actor
      // before. To stay simple, we maintain an actor cache keyed on clientID.
      for (const cid of delta.removed) {
        const cached = this.clientIdToActor.get(cid);
        if (cached) departed.add(cached);
        this.clientIdToActor.delete(cid);
      }
      // Update cache for current peers.
      for (const [cid, s] of aw.getStates()) {
        const a = (s as { actor?: string }).actor;
        if (typeof a === "string") this.clientIdToActor.set(cid, a);
      }
      if (departed.size === 0) return;
      // Reap locks AND territory claims held by departed actors.
      this.ydoc.transact(() => {
        for (const [file, entry] of this.locks.entries()) {
          if (departed.has(entry.actor)) {
            this.locks.delete(file);
          }
        }
        for (const actor of departed) {
          if (this.territories.has(actor)) this.territories.delete(actor);
        }
        // Mark them offline in the actors map so /rooms-status reflects the drop.
        for (const actor of departed) {
          const cur = this.actors.get(actor);
          if (cur) {
            this.actors.set(actor, { ...cur, online: false });
          }
        }
      });
    });
    // Seed cache with our own clientID.
    if (aw.clientID !== undefined) {
      this.clientIdToActor.set(aw.clientID, this.me);
    }
  }
  private clientIdToActor = new Map<number, string>();

  /** Local read of the live Y.Doc. Sub-100ms. */
  getSnapshot(): RoomSnapshot {
    const now = Date.now();
    const actors: ActorStateView[] = [];
    for (const [actorName, v] of this.actors) {
      const claim = this.territories.get(actorName);
      const territory = claim && !this.isClaimExpired(claim, now) ? claim : null;
      actors.push({ ...v, territory });
    }
    const locks: Array<{ file: string; entry: LockEntry }> = [];
    for (const [file, entry] of this.locks) {
      if (now - entry.acquired_at_ms > entry.ttl_ms) continue; // hide expired
      locks.push({ file, entry });
    }
    const online_peer_count = actors.filter((a) => a.online && a.actor !== this.me).length;

    // Territory overlap: any of my recently-touched files (files_open + last
    // action files) intersected with any teammate's active territory.
    const me = actors.find((a) => a.actor === this.me);
    const myFiles = new Set<string>();
    if (me) {
      for (const f of me.files_open ?? []) myFiles.add(f);
      if (me.last_action && Array.isArray(me.last_action.files)) {
        for (const f of me.last_action.files) myFiles.add(f);
      }
    }
    const teammates = actors
      .filter((a) => a.actor !== this.me)
      .map((a) => ({ actor: a.actor, territory: a.territory ?? null }));
    const territory_overlap = findOverlaps([...myFiles], teammates);

    return {
      schema_version: SCHEMA_VERSION,
      room_code: this.roomCode,
      me: this.me,
      actors,
      locks,
      online_peer_count,
      territory_overlap,
    };
  }

  // ---- Territory ----

  isClaimExpired(claim: TerritoryClaim, now = Date.now()): boolean {
    return now - claim.claimed_at_ms > claim.ttl_ms;
  }

  /** Replace this actor's territory claim. */
  claimTerritory(globs: string[], purpose: string, ttlMs = DEFAULT_TERRITORY_TTL_MS): TerritoryClaim {
    const claim: TerritoryClaim = {
      globs: [...globs],
      purpose: purpose.slice(0, 200),
      claimed_at_ms: Date.now(),
      ttl_ms: ttlMs,
    };
    this.ydoc.transact(() => {
      this.territories.set(this.me, claim);
    });
    return claim;
  }

  releaseTerritory(): void {
    this.ydoc.transact(() => {
      this.territories.delete(this.me);
    });
  }

  getMyTerritory(): TerritoryClaim | null {
    const c = this.territories.get(this.me);
    if (!c) return null;
    return this.isClaimExpired(c) ? null : c;
  }

  /** Check whether the supplied files overlap any teammate's active territory.
   *  Returns empty array if not. Caller can use this on the PreToolUse path
   *  to emit a soft warning. */
  checkTerritoryOverlap(files: string[]): TerritoryOverlap[] {
    const now = Date.now();
    const teammates: Array<{ actor: string; territory: TerritoryClaim | null }> = [];
    for (const [actor, claim] of this.territories) {
      if (actor === this.me) continue;
      if (this.isClaimExpired(claim, now)) continue;
      teammates.push({ actor, territory: claim });
    }
    return findOverlaps(files, teammates);
  }

  // ---- Plan state ----

  /** Update this actor's plan record. Called by both hooks (in_plan_mode
   *  signal from permission_mode) and by the update_my_plan MCP tool. */
  updatePlan(patch: Partial<PlanState>): void {
    this.ydoc.transact(() => {
      const cur = this.actors.get(this.me);
      const existing = cur?.plan ?? null;
      const next: PlanState = {
        in_plan_mode: existing?.in_plan_mode ?? false,
        summary: existing?.summary ?? "",
        steps_total: existing?.steps_total ?? 0,
        steps_done: existing?.steps_done ?? 0,
        updated_at_ms: Date.now(),
        ...patch,
      };
      // If nothing meaningful is set, leave plan null to avoid empty UI rows.
      const meaningful = next.in_plan_mode || next.summary.length > 0
        || next.steps_total > 0 || next.steps_done > 0;
      const merged: ActorState = {
        ...(cur ?? this.makeInitialSelf()),
        plan: meaningful ? next : null,
        last_heartbeat_ms: Date.now(),
      };
      this.actors.set(this.me, merged);
    });
  }

  // ---- Git state ----

  /** Merge a git refresh from this actor's hooks. If the supplied state is
   *  light (no commits) and `head` matches a previously cached entry, the
   *  cached commits are preserved. Throttled to one full refresh per 5s. */
  mergeGitState(input: GitState | null, opts: { includeCommits: boolean }): void {
    const now = Date.now();
    if (opts.includeCommits) {
      if (now - this.lastFullGitRefreshMs < GIT_FULL_REFRESH_MIN_INTERVAL_MS) {
        // Throttle: degrade to a light refresh.
        opts = { includeCommits: false };
      } else {
        this.lastFullGitRefreshMs = now;
      }
    }
    this.ydoc.transact(() => {
      const cur = this.actors.get(this.me) ?? this.makeInitialSelf();
      let nextGit: GitState | null = input;
      if (input && !opts.includeCommits) {
        // Preserve cached commits if HEAD did not change.
        const prev = cur.git ?? null;
        if (prev && prev.head === input.head) {
          nextGit = { ...input, recent_commits: prev.recent_commits };
        } else {
          nextGit = { ...input, recent_commits: [] };
        }
      }
      const merged: ActorState = {
        ...cur,
        git: nextGit,
        // Also mirror branch into the existing top-level branch field so old
        // v1 clients see something useful.
        branch: nextGit?.branch ?? cur.branch,
        last_heartbeat_ms: Date.now(),
      };
      this.actors.set(this.me, merged);
    });
  }

  // ---- Last prompt ----

  setLastPrompt(prompt: LastPromptState | null): void {
    this.ydoc.transact(() => {
      const cur = this.actors.get(this.me) ?? this.makeInitialSelf();
      this.actors.set(this.me, {
        ...cur,
        last_prompt: prompt,
        last_heartbeat_ms: Date.now(),
      });
    });
  }

  private makeInitialSelf(): ActorState {
    return {
      actor: this.me,
      focus: "",
      branch: "",
      files_open: [],
      last_action: null,
      recent_actions: [],
      blockers: [],
      online: true,
      last_heartbeat_ms: Date.now(),
    };
  }

  /** Merge a partial actor state for `me`. Debounced 250ms so fast tool
   *  loops do not flood the WebRTC mesh. */
  setMyState(patch: Partial<ActorState>): void {
    this.pendingPatch = { ...(this.pendingPatch ?? {}), ...patch };
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => this.flushMyState(), SET_MY_STATE_DEBOUNCE_MS);
  }

  /** Force-flush any pending debounced state. Used at shutdown. */
  flushMyState(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (!this.pendingPatch) return;
    const patch = this.pendingPatch;
    this.pendingPatch = null;
    this.ydoc.transact(() => {
      const cur = this.actors.get(this.me);
      const base: ActorState = cur ?? {
        actor: this.me,
        focus: "",
        branch: "",
        files_open: [],
        last_action: null,
        recent_actions: [],
        blockers: [],
        online: true,
        last_heartbeat_ms: Date.now(),
      };
      const merged: ActorState = {
        ...base,
        ...patch,
        actor: this.me, // never let a patch rename us
        last_heartbeat_ms: Date.now(),
      };
      // Recent-actions cap.
      if (merged.recent_actions.length > RECENT_ACTIONS_CAP) {
        merged.recent_actions = merged.recent_actions.slice(-RECENT_ACTIONS_CAP);
      }
      this.actors.set(this.me, merged);
    });
  }

  /** Append a new last_action and rotate the previous one into recent_actions.
   *  Bypasses the setMyState debounce so each action is recorded immediately;
   *  recordAction is called on Stop, not on every tool call, so it is not noisy. */
  recordAction(action: ActionEvent): void {
    // Flush any pending debounced state so we read the freshest values.
    this.flushMyState();
    this.ydoc.transact(() => {
      const cur = this.actors.get(this.me);
      const recent_actions = cur ? [...cur.recent_actions] : [];
      if (cur && cur.last_action) {
        recent_actions.push(cur.last_action);
        if (recent_actions.length > RECENT_ACTIONS_CAP) {
          recent_actions.splice(0, recent_actions.length - RECENT_ACTIONS_CAP);
        }
      }
      const base: ActorState = cur ?? {
        actor: this.me,
        focus: "",
        branch: "",
        files_open: [],
        last_action: null,
        recent_actions: [],
        blockers: [],
        online: true,
        last_heartbeat_ms: Date.now(),
      };
      this.actors.set(this.me, {
        ...base,
        last_action: action,
        recent_actions,
        last_heartbeat_ms: Date.now(),
      });
    });
  }

  /** Atomic try-acquire. Re-acquire is a no-op refresh; collisions return held entries. */
  tryAcquireLocks(files: string[]): TryAcquireResult {
    const now = Date.now();
    const held: Array<{ file: string; actor: string }> = [];
    let ok = true;
    this.ydoc.transact(() => {
      // Check phase.
      for (const file of files) {
        const existing = this.locks.get(file);
        if (existing && existing.actor !== this.me && !this.isExpired(existing, now)) {
          held.push({ file, actor: existing.actor });
          ok = false;
        }
      }
      if (!ok) return;
      // Acquire phase.
      for (const file of files) {
        this.locks.set(file, {
          actor: this.me,
          acquired_at_ms: now,
          ttl_ms: this.lockTtlMs,
        });
      }
    });
    return ok ? { ok: true } : { ok: false, held };
  }

  releaseLocks(files: string[]): void {
    this.ydoc.transact(() => {
      for (const file of files) {
        const e = this.locks.get(file);
        if (e && e.actor === this.me) this.locks.delete(file);
      }
    });
  }

  refreshLockTtl(files: string[]): void {
    const now = Date.now();
    this.ydoc.transact(() => {
      for (const file of files) {
        const e = this.locks.get(file);
        if (e && e.actor === this.me) {
          this.locks.set(file, { ...e, acquired_at_ms: now });
        }
      }
    });
  }

  /** Release all locks held by this actor. Used at SessionEnd. */
  releaseAllMyLocks(): void {
    this.ydoc.transact(() => {
      for (const [file, e] of this.locks.entries()) {
        if (e.actor === this.me) this.locks.delete(file);
      }
    });
  }

  /** Mark this actor offline, release locks, release territory, destroy awareness. */
  markOffline(): void {
    this.flushMyState();
    this.releaseAllMyLocks();
    this.releaseTerritory();
    this.ydoc.transact(() => {
      const cur = this.actors.get(this.me);
      if (cur) this.actors.set(this.me, { ...cur, online: false });
    });
    if (this.awareness) {
      try { this.awareness.setLocalState(null); } catch { /* ignore */ }
      try { this.awareness.destroy(); } catch { /* ignore */ }
      this.awareness = null;
    }
  }

  isExpired(entry: LockEntry, now = Date.now()): boolean {
    return now - entry.acquired_at_ms > entry.ttl_ms;
  }

  /** Internal: re-acquire expired locks previously held by this actor.
   *  Called by the MCP server on every state-read tick.
   *  If a file has been taken by someone else during the gap, append a
   *  stale_lock_reclaimed_by_other event to recent_actions. */
  reconcileMyExpiredLocks(previouslyHeld: string[]): void {
    if (previouslyHeld.length === 0) return;
    const now = Date.now();
    const reclaimedByOther: Array<{ file: string; by: string }> = [];
    this.ydoc.transact(() => {
      for (const file of previouslyHeld) {
        const cur = this.locks.get(file);
        const isMineAndExpired = cur && cur.actor === this.me && this.isExpired(cur, now);
        if (!cur || isMineAndExpired) {
          // Either gone, or my own expired entry: silently reclaim for self.
          this.locks.set(file, { actor: this.me, acquired_at_ms: now, ttl_ms: this.lockTtlMs });
        } else if (cur.actor !== this.me && !this.isExpired(cur, now)) {
          reclaimedByOther.push({ file, by: cur.actor });
        }
      }
    });
    if (reclaimedByOther.length > 0) {
      for (const { file, by } of reclaimedByOther) {
        this.recordAction({
          type: "stale_lock_reclaimed_by_other",
          files: [file],
          summary: `lock on ${file} was taken by ${by} while ours was expired`,
          timestamp_ms: Date.now(),
          details: { by },
        });
      }
    }
  }

  /** Files I currently hold locks on (non-expired). */
  myLockedFiles(): string[] {
    const out: string[] = [];
    const now = Date.now();
    for (const [file, e] of this.locks.entries()) {
      if (e.actor === this.me && !this.isExpired(e, now)) out.push(file);
    }
    return out;
  }

  async disconnect(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.flushMyState();
    if (this.provider) {
      try { this.provider.disconnect(); } catch { /* ignore */ }
      try { this.provider.destroy(); } catch { /* ignore */ }
      this.provider = null;
    }
    if (this.awareness) {
      try { this.awareness.destroy(); } catch { /* ignore */ }
      this.awareness = null;
    }
    try { this.ydoc.destroy(); } catch { /* ignore */ }
  }

  /** Underlying Y.Doc, exposed for tests only. */
  get _ydocForTests(): Y.Doc {
    return this.ydoc;
  }
}
