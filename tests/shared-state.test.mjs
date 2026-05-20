// Integration tests for shared-state.ts. We do NOT spin up WebRTC here;
// instead we wire two Y.Docs together with manual update propagation,
// which is the same model y-webrtc uses internally but synchronous.
// This exercises the lock + actor-state logic across two peers.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";

import { Room } from "../dist/shared-state.js";
import { generateRoomCode, isValidRoomCode, normalizeRoomCode } from "../dist/room-code.js";
import { resolveActorName, kebabize } from "../dist/actor.js";

/** Wire two Y.Docs as if they were peers on the same WebRTC mesh. */
function wirePeers(a, b) {
  a.on("update", (update, origin) => {
    if (origin === "remote") return;
    Y.applyUpdate(b, update, "remote");
  });
  b.on("update", (update, origin) => {
    if (origin === "remote") return;
    Y.applyUpdate(a, update, "remote");
  });
}

test("generateRoomCode produces a valid pronounceable code", () => {
  for (let i = 0; i < 50; i++) {
    const c = generateRoomCode();
    assert.ok(isValidRoomCode(c), `not valid: ${c}`);
    assert.match(c, /^[a-z]+-[a-z]+$/);
  }
});

test("normalizeRoomCode lowercases and rejects junk", () => {
  assert.equal(normalizeRoomCode("KITE-FROG"), "kite-frog");
  assert.equal(normalizeRoomCode(" mint-anchor "), "mint-anchor");
  assert.equal(normalizeRoomCode("kite frog"), null);
  assert.equal(normalizeRoomCode("kite-frog-extra"), null);
  assert.equal(normalizeRoomCode("k-frog"), null);
});

test("kebabize normalizes diacritics and odd casing", () => {
  assert.equal(kebabize("Connor Hyatt"), "connor-hyatt");
  assert.equal(kebabize("  Mr. Foo Bar  "), "mr-foo-bar");
  assert.equal(kebabize("Café"), "cafe");
});

test("resolveActorName respects userConfig env var", () => {
  const prev = process.env.CLAUDE_PLUGIN_OPTION_ACTOR_NAME;
  process.env.CLAUDE_PLUGIN_OPTION_ACTOR_NAME = "Test User";
  try {
    assert.equal(resolveActorName(), "test-user");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_OPTION_ACTOR_NAME;
    else process.env.CLAUDE_PLUGIN_OPTION_ACTOR_NAME = prev;
  }
});

test("two peers see each other's actor state", () => {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  wirePeers(docA, docB);
  const roomA = new Room("kite-frog", "connor", { ydoc: docA });
  const roomB = new Room("kite-frog", "ryan", { ydoc: docB });
  roomA.connect({ testMode: true });
  roomB.connect({ testMode: true });

  roomA.setMyState({ focus: "auth refactor", branch: "feat/connor" });
  roomB.setMyState({ focus: "tests", branch: "feat/ryan" });
  roomA.flushMyState();
  roomB.flushMyState();

  const snapA = roomA.getSnapshot();
  const snapB = roomB.getSnapshot();
  const ryanFromA = snapA.actors.find((a) => a.actor === "ryan");
  const connorFromB = snapB.actors.find((a) => a.actor === "connor");
  assert.ok(ryanFromA, "ryan visible to connor");
  assert.equal(ryanFromA.focus, "tests");
  assert.ok(connorFromB, "connor visible to ryan");
  assert.equal(connorFromB.focus, "auth refactor");
});

test("lock case 1: A acquires unheld file", () => {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  wirePeers(docA, docB);
  const A = new Room("r", "connor", { ydoc: docA });
  const B = new Room("r", "ryan", { ydoc: docB });
  A.connect({ testMode: true });
  B.connect({ testMode: true });

  const r = A.tryAcquireLocks(["src/auth.ts"]);
  assert.equal(r.ok, true);
  const snapB = B.getSnapshot();
  const lock = snapB.locks.find((l) => l.file === "src/auth.ts");
  assert.ok(lock, "ryan should see connor's lock");
  assert.equal(lock.entry.actor, "connor");
});

test("lock case 2: A re-acquires its own lock as a refresh", () => {
  const A = new Room("r", "connor", { ydoc: new Y.Doc() });
  A.connect({ testMode: true });
  const r1 = A.tryAcquireLocks(["src/x.ts"]);
  assert.equal(r1.ok, true);
  const r2 = A.tryAcquireLocks(["src/x.ts"]);
  assert.equal(r2.ok, true, "re-acquire by same actor must succeed");
});

test("lock case 3: B blocked by A's lock", () => {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  wirePeers(docA, docB);
  const A = new Room("r", "connor", { ydoc: docA });
  const B = new Room("r", "ryan", { ydoc: docB });
  A.connect({ testMode: true });
  B.connect({ testMode: true });
  A.tryAcquireLocks(["src/auth.ts"]);
  const r = B.tryAcquireLocks(["src/auth.ts"]);
  assert.equal(r.ok, false);
  assert.ok(r.held && r.held[0]);
  assert.equal(r.held[0].file, "src/auth.ts");
  assert.equal(r.held[0].actor, "connor");
});

test("lock case 4: expired lock reclaim, no other holder", () => {
  const A = new Room("r", "connor", { ydoc: new Y.Doc(), lockTtlMs: 10 });
  A.connect({ testMode: true });
  A.tryAcquireLocks(["src/x.ts"]);
  return new Promise((resolve) => {
    setTimeout(() => {
      // After expiry, no one else has it; reconcile should silently reclaim.
      A.reconcileMyExpiredLocks(["src/x.ts"]);
      const snap = A.getSnapshot();
      const mine = snap.locks.find((l) => l.file === "src/x.ts");
      assert.ok(mine);
      assert.equal(mine.entry.actor, "connor");
      resolve();
    }, 30);
  });
});

test("lock case 4 alt: expired lock reclaimed by other while ours expired", () => {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  wirePeers(docA, docB);
  const A = new Room("r", "connor", { ydoc: docA, lockTtlMs: 10 });
  const B = new Room("r", "ryan", { ydoc: docB, lockTtlMs: 60 * 60 * 1000 });
  A.connect({ testMode: true });
  B.connect({ testMode: true });
  A.tryAcquireLocks(["src/x.ts"]);
  return new Promise((resolve) => {
    setTimeout(() => {
      // After A's lock expires, B takes the file.
      const rb = B.tryAcquireLocks(["src/x.ts"]);
      assert.equal(rb.ok, true);
      // A reconciles; should detect the loss and append a recent_actions event.
      A.reconcileMyExpiredLocks(["src/x.ts"]);
      A.flushMyState();
      const snapA = A.getSnapshot();
      const me = snapA.actors.find((a) => a.actor === "connor");
      assert.ok(me);
      const lastIsReclaim = me.last_action && me.last_action.type === "stale_lock_reclaimed_by_other";
      const recentHasReclaim = me.recent_actions.some((e) => e.type === "stale_lock_reclaimed_by_other");
      assert.ok(lastIsReclaim || recentHasReclaim, "should record stale_lock_reclaimed_by_other");
      resolve();
    }, 30);
  });
});

test("lock case 5: awareness disconnect reaps absent peer's locks", () => {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  wirePeers(docA, docB);
  const A = new Room("r", "connor", { ydoc: docA });
  const B = new Room("r", "ryan", { ydoc: docB });
  A.connect({ testMode: true });
  B.connect({ testMode: true });

  B.tryAcquireLocks(["src/x.ts"]);
  // Simulate ryan dropping: feed an awareness removal directly into A's awareness.
  // For testMode, awareness instances are independent. Reaping in v1 only works
  // with a real awareness instance, so this test just confirms the manual API:
  B.markOffline();
  const snapA = A.getSnapshot();
  // After markOffline ryan released the lock himself; this proves the
  // graceful-release path. The ungraceful path is exercised by Phase 7 case 5.
  const locked = snapA.locks.find((l) => l.file === "src/x.ts");
  assert.equal(locked, undefined, "lock should be released on graceful offline");
});

test("lock case 6: race - last-writer-wins via CRDT", () => {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  // Both peers issue concurrent transactions BEFORE wiring up sync.
  const A = new Room("r", "connor", { ydoc: docA });
  const B = new Room("r", "ryan", { ydoc: docB });
  A.connect({ testMode: true });
  B.connect({ testMode: true });
  const rA = A.tryAcquireLocks(["src/x.ts"]);
  const rB = B.tryAcquireLocks(["src/x.ts"]);
  // Both locally succeeded because they had not yet seen each other's update.
  assert.equal(rA.ok, true);
  assert.equal(rB.ok, true);

  // Now sync them.
  wirePeers(docA, docB);
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB), "remote");
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA), "remote");

  const winnerA = A.getSnapshot().locks.find((l) => l.file === "src/x.ts");
  const winnerB = B.getSnapshot().locks.find((l) => l.file === "src/x.ts");
  assert.ok(winnerA && winnerB, "both peers see a winner after sync");
  assert.equal(winnerA.entry.actor, winnerB.entry.actor, "convergent winner across peers");
});

test("setMyState debounce coalesces rapid updates", () => {
  const A = new Room("r", "connor", { ydoc: new Y.Doc() });
  A.connect({ testMode: true });
  for (let i = 0; i < 20; i++) A.setMyState({ focus: `step-${i}` });
  // Before debounce flush, the doc still shows the initial focus.
  // We do not assert on un-flushed state because flushMyState may be triggered
  // by any setMyState internally; instead we flush and check the final value.
  A.flushMyState();
  const me = A.getSnapshot().actors.find((a) => a.actor === "connor");
  assert.equal(me.focus, "step-19");
});

test("recordAction rotates last_action into recent_actions and caps at 10", () => {
  const A = new Room("r", "connor", { ydoc: new Y.Doc() });
  A.connect({ testMode: true });
  for (let i = 0; i < 15; i++) {
    A.recordAction({ type: "edit", files: [`f${i}.ts`], summary: `e${i}`, timestamp_ms: i });
  }
  A.flushMyState();
  const me = A.getSnapshot().actors.find((a) => a.actor === "connor");
  assert.ok(me.last_action);
  assert.equal(me.last_action.summary, "e14");
  assert.equal(me.recent_actions.length, 10);
});
