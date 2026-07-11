/**
 * Deterministic Player tests: requestAnimationFrame is stubbed with a manual
 * clock so marker semantics (pause / next / outro / loop / end) are exact.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Composition } from '@riposte/shared';
import { Player } from '../src/player.ts';

// ---- rAF stub with a manual clock -----------------------------------------
let pending: Array<(ts: number) => void> = [];
let now = 0;

(globalThis as Record<string, unknown>)['requestAnimationFrame'] = (cb: (ts: number) => void): number => {
  pending.push(cb);
  return pending.length;
};
(globalThis as Record<string, unknown>)['cancelAnimationFrame'] = (): void => {
  pending = [];
};

/** Advance the fake clock in `stepMs` increments, firing queued rAF callbacks. */
function run(ms: number, stepMs = 10): void {
  const end = now + ms;
  while (now < end && pending.length > 0) {
    now = Math.min(now + stepMs, end);
    const cbs = pending;
    pending = [];
    for (const cb of cbs) cb(now);
  }
}

function comp(overrides: Partial<Composition> = {}): Composition {
  return {
    width: 1920,
    height: 1080,
    fps: 50,
    duration: 100,
    markers: [
      { frame: 40, type: 'pause' },
      { frame: 70, type: 'outro' },
    ],
    layers: [],
    ...overrides,
  };
}

interface Log {
  frames: number[];
  ended: number;
  actions: string[];
}

function makePlayer(c: Composition): { p: Player; log: Log } {
  const log: Log = { frames: [], ended: 0, actions: [] };
  const p = new Player(c, {
    onFrame: (f) => log.frames.push(f),
    onEnded: () => log.ended++,
    runAction: (src) => log.actions.push(src),
  });
  return { p, log };
}

beforeEach(() => {
  pending = [];
  now = 0;
});

test('play parks exactly on the pause marker', () => {
  const { p } = makePlayer(comp());
  p.play({ from: 0 });
  run(5000); // way past 40 frames at 50fps (800ms)
  assert.equal(p.activeFrame, 40);
  assert.equal(p.playing, false);
});

test('resume continues past the pause and ends at the last frame', () => {
  const { p, log } = makePlayer(comp());
  p.play({ from: 0 });
  run(5000);
  assert.equal(p.activeFrame, 40);
  assert.equal(p.resume(), true);
  run(5000);
  assert.equal(p.activeFrame, 99); // duration-1
  assert.equal(p.playing, false);
  assert.equal(log.ended, 1);
});

test('resume is a no-op while playing', () => {
  const { p } = makePlayer(comp());
  p.play({ from: 0 });
  run(100); // still before pause
  assert.equal(p.playing, true);
  assert.equal(p.resume(), false);
});

test('outro marker is passive during play; goToAndPlay from it reaches the end', () => {
  const { p, log } = makePlayer(comp());
  p.play({ from: 0 });
  run(5000);
  p.resume();
  run(5000); // ran through outro@70 without stopping there
  assert.equal(log.ended, 1);

  const { p: p2, log: log2 } = makePlayer(comp());
  p2.goToAndPlay(70); // = stop() behavior
  run(5000);
  assert.equal(p2.activeFrame, 99);
  assert.equal(log2.ended, 1);
});

test('loop marker jumps back and keeps playing', () => {
  const c = comp({
    markers: [{ frame: 30, type: 'loop', loopToFrame: 10 }],
  });
  const { p } = makePlayer(c);
  p.play({ from: 0 });
  run(3000); // several loop roundtrips worth of time
  assert.equal(p.playing, true);
  assert.ok(p.activeFrame >= 10 && p.activeFrame < 30, `looping range, got ${p.activeFrame}`);
});

test('action markers fire once per crossing, in frame order', () => {
  const c = comp({
    markers: [
      { frame: 5, type: 'action', source: 'A' },
      { frame: 15, type: 'action', source: 'B' },
      { frame: 40, type: 'pause' },
    ],
  });
  const { p, log } = makePlayer(c);
  p.play({ from: 0 });
  run(5000);
  assert.deepEqual(log.actions, ['A', 'B']);
});

test('goTo renders the frame without playing', () => {
  const { p, log } = makePlayer(comp());
  p.goTo(60);
  assert.equal(p.activeFrame, 60);
  assert.equal(p.playing, false);
  assert.ok(log.frames.includes(60));
});

test('frames render monotonically without skipped marker processing at high dt', () => {
  // 250ms steps = 12.5 frames per tick; pause at 40 must still catch exactly
  const { p } = makePlayer(comp());
  p.play({ from: 0 });
  run(10000, 250);
  assert.equal(p.activeFrame, 40);
});
