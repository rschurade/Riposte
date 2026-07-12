/**
 * Loop-region semantics: the pure frame warp (entrance → wrap-with-hold →
 * exit) and the Player hooks that drive it (onPaused / onOutro).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Composition } from '@riposte/shared';
import { loopWarp, type LoopTimeState } from '../src/dom.ts';
import { Player } from '../src/player.ts';

// ---- loopWarp ---------------------------------------------------------------

// Layer starts at scene frame 5; local loop region 10..30 (comp 15..35),
// exit content after comp frame 35.
const LOOP = { start: 10, end: 30 };
const START = 5;

function state(over: Partial<LoopTimeState> = {}): LoopTimeState {
  return { hold: 0, exiting: false, exitFrom: 0, ...over };
}

test('entrance is untouched below the loop start', () => {
  assert.equal(loopWarp(5, START, LOOP, state()), 5);
  assert.equal(loopWarp(14, START, LOOP, state()), 14);
});

test('frames past loop end wrap into the region (deterministic seek)', () => {
  assert.equal(loopWarp(15, START, LOOP, state()), 15);
  assert.equal(loopWarp(35, START, LOOP, state()), 15); // exactly one lap
  assert.equal(loopWarp(41, START, LOOP, state()), 21);
});

test('hold time keeps the cycle moving while the playhead is parked', () => {
  // parked at comp frame 40 (a pause), hold advancing
  assert.equal(loopWarp(40, START, LOOP, state({ hold: 0 })), 20);
  assert.equal(loopWarp(40, START, LOOP, state({ hold: 5 })), 25);
  assert.equal(loopWarp(40, START, LOOP, state({ hold: 15 })), 15); // wrapped
});

test('exiting does not change the warp — the cycle continues under the fade', () => {
  const s = state({ exiting: true, exitFrom: 40 });
  assert.equal(loopWarp(40, START, LOOP, s), loopWarp(40, START, LOOP, state()));
  assert.equal(loopWarp(45, START, LOOP, s), loopWarp(45, START, LOOP, state()));
});

// ---- Player hooks -------------------------------------------------------------

let pending: Array<(ts: number) => void> = [];
let now = 0;
(globalThis as Record<string, unknown>)['requestAnimationFrame'] = (cb: (ts: number) => void): number => {
  pending.push(cb);
  return pending.length;
};
(globalThis as Record<string, unknown>)['cancelAnimationFrame'] = (): void => {
  pending = [];
};
function run(ms: number, stepMs = 10): void {
  const end = now + ms;
  while (now < end && pending.length > 0) {
    now = Math.min(now + stepMs, end);
    const cbs = pending;
    pending = [];
    for (const cb of cbs) cb(now);
  }
}

beforeEach(() => {
  pending = [];
  now = 0;
});

const COMP: Composition = {
  width: 1920,
  height: 1080,
  fps: 50,
  duration: 100,
  markers: [
    { frame: 40, type: 'pause' },
    { frame: 70, type: 'outro' },
  ],
  layers: [],
};

test('onPaused fires when parking, onOutro when crossing the outro marker', () => {
  const events: string[] = [];
  const p = new Player(COMP, {
    onFrame: () => {},
    onEnded: () => events.push('ended'),
    runAction: () => {},
    onPaused: (f) => events.push(`paused@${f}`),
    onOutro: (f) => events.push(`outro@${f}`),
  });
  p.play({ from: 0 });
  run(5000);
  assert.deepEqual(events, ['paused@40']);
  p.resume();
  run(5000);
  assert.deepEqual(events, ['paused@40', 'outro@70', 'ended']);
});
