/**
 * Loop-region semantics: the pure frame warp (entrance → wrap-with-hold →
 * exit) and the Player hooks that drive it (onPaused / onOutro).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Composition, SceneDoc } from '@riposte/shared';
import { docHasLoops, forwardClock, loopWarp, type LoopTimeState } from '../src/dom.ts';
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

// ---- forwardClock (nested components) ----------------------------------------
// Component layer at parent frame 20, child duration 50 (subLast 49); the
// child carries a loop layer at START with LOOP — the numbers assert that a
// nested loop cycles exactly like a top-level one would.

const C_START = 20;
const C_LAST = 49;

function childWarpAt(parentFrame: number, parent: LoopTimeState): number {
  const child = state();
  const f = forwardClock(parent, child, parentFrame, C_START, C_LAST);
  return loopWarp(f, START, LOOP, child);
}

test('within the child duration the clock passes through untouched', () => {
  const child = state();
  assert.equal(forwardClock(state(), child, 30, C_START, C_LAST), 10);
  assert.equal(child.hold, 0);
  // before the component starts: clamped to 0
  assert.equal(forwardClock(state(), child, 5, C_START, C_LAST), 0);
});

test('nested loop keeps cycling while the parent plays PAST the child end', () => {
  // parent 69 = child end; every parent frame beyond overflows into hold
  const atEnd = childWarpAt(69, state());
  assert.equal(childWarpAt(70, state()), atEnd + 1 <= 34 ? atEnd + 1 : 15);
  // ten frames later the cycle has advanced ten frames (mod the span)
  const span = LOOP.end - LOOP.start;
  assert.equal(childWarpAt(79, state()), START + LOOP.start + ((atEnd - START - LOOP.start + 10) % span));
});

test('nested loop keeps cycling while the parent is parked (hold clock)', () => {
  // parent parked at 40 (inside the child), hold advancing
  const a = childWarpAt(40, state({ hold: 0 }));
  const b = childWarpAt(40, state({ hold: 5 }));
  const span = LOOP.end - LOOP.start;
  assert.equal(b, START + LOOP.start + ((a - START - LOOP.start + 5) % span));
});

test('exit fade progress survives the child clamp', () => {
  // outro latched at parent 80 — beyond the child's end (child parked at 49)
  const child = state();
  const f = forwardClock(state({ exiting: true, exitFrom: 80 }), child, 85, C_START, C_LAST);
  assert.equal(child.exiting, true);
  // fade progress as the child's fade dynamic computes it: frame - exitFrom
  assert.equal(f - child.exitFrom, 85 - 80);
});

// ---- docHasLoops -------------------------------------------------------------

function comp(layers: Composition['layers']): Composition {
  return { width: 1920, height: 1080, fps: 50, duration: 100, markers: [], layers };
}

function compLayer(id: string, compositionId: string): Composition['layers'][number] {
  return {
    id,
    startFrame: 0,
    duration: 100,
    element: { id: `${id}-el`, type: 'composition', compositionId, style: { x: { value: 0 }, y: { value: 0 } } },
  };
}

const LOOP_LAYER: Composition['layers'][number] = {
  id: 'l1',
  startFrame: 0,
  duration: 100,
  loop: { start: 10, end: 30 },
  element: { id: 'l1-el', type: 'rectangle', style: { x: { value: 0 }, y: { value: 0 } } },
};

test('docHasLoops sees loops at the top level and inside components', () => {
  assert.equal(docHasLoops(comp([LOOP_LAYER]), undefined), true);
  assert.equal(docHasLoops(comp([compLayer('c', 'scenes/x.json')]), undefined), false);
  const components = { 'scenes/x.json': { composition: comp([LOOP_LAYER]) } as SceneDoc };
  assert.equal(docHasLoops(comp([compLayer('c', 'scenes/x.json')]), components), true);
});

test('docHasLoops survives cyclic component references (depth guard)', () => {
  const cyclic = { 'scenes/a.json': { composition: comp([compLayer('c', 'scenes/a.json')]) } as SceneDoc };
  assert.equal(docHasLoops(comp([compLayer('c', 'scenes/a.json')]), cyclic), false);
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
