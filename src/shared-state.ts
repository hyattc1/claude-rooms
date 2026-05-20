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
}

export interface LockEntry {
  actor: string;
  acquired_at_ms: number;
  ttl_ms: number;
}

export const DEFAULT_LOCK_TTL_MS = 60 * 60 * 1000; // 60 minutes
export const SET_MY_STATE_DEBOUNCE_MS = 250;
export const RECENT_ACTIONS_CAP = 10;

export interface RoomSnapshot {
  room_code: string;
  me: string;
  actors: ActorState[];
  locks: Array<{ file: string; entry: LockEntry }>;
  online_peer_count: number;
}

export interface TryAcquireResult {
  ok: boolean;
  held?: Array<{ file: string; actor: string }>;
}

export class Room {
  readonly roomCode: string;
  readonly me: string;
  private ydoc: Y.Doc;
  private provider: WebrtcProvider | null = null;
  private awareness: Awareness | null = null;
  private actors!: Y.Map<ActorState>;
  private locks!: Y.Map<LockEntry>;
  private events!: Y.Map<unknown>; // reserved for room-level events; unused in v1
  private pendingPatch: Partial<ActorState> | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private lockTtlMs: number;

  constructor(roomCode: string, me: string, opts: { lockTtlMs?: number; ydoc?: Y.Doc } = {}) {
    this.roomCode = roomCode;
    this.me = me;
    this.lockTtlMs = opts.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    this.ydoc = opts.ydoc ?? new Y.Doc();
    this.actors = this.ydoc.getMap<ActorState>("actors");
    this.locks = this.ydoc.getMap<LockEntry>("locks");
    this.events = this.ydoc.getMap("events");
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
      // Reap locks held by departed actors.
      this.ydoc.transact(() => {
        for (const [file, entry] of this.locks.entries()) {
          if (departed.has(entry.actor)) {
            this.locks.delete(file);
          }
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
    const actors: ActorState[] = [];
    for (const [, v] of this.actors) actors.push(v);
    const locks: Array<{ file: string; entry: LockEntry }> = [];
    const now = Date.now();
    for (const [file, entry] of this.locks) {
      if (now - entry.acquired_at_ms > entry.ttl_ms) continue; // hide expired
      locks.push({ file, entry });
    }
    const online_peer_count = actors.filter((a) => a.online && a.actor !== this.me).length;
    return {
      room_code: this.roomCode,
      me: this.me,
      actors,
      locks,
      online_peer_count,
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

  /** Mark this actor offline, release locks, destroy awareness. */
  markOffline(): void {
    this.flushMyState();
    this.releaseAllMyLocks();
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
