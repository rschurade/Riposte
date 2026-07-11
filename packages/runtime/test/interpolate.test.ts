import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valueAtFrame, numberAtFrame } from '../src/interpolate.ts';
import type { StyleProperty } from '@riposte/shared';

test('no keyframes returns static value', () => {
  assert.equal(valueAtFrame({ value: 42 }, 10), 42);
});

test('static value is IGNORED when keyframes exist (Loopic semantics)', () => {
  const p: StyleProperty = { value: 999, keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 100 }] };
  assert.equal(valueAtFrame(p, 0), 0);
  assert.equal(valueAtFrame(p, 5), 50);
  assert.equal(valueAtFrame(p, 10), 100);
});

test('clamps before first and after last keyframe', () => {
  const p: StyleProperty = { value: 0, keyframes: [{ frame: 5, value: 10 }, { frame: 15, value: 20 }] };
  assert.equal(valueAtFrame(p, 0), 10);
  assert.equal(valueAtFrame(p, 99), 20);
});

test('easing applies toward the NEXT keyframe', () => {
  const easeIn = { p1x: 0.9, p1y: 0, p2x: 1, p2y: 0.4 };
  const p: StyleProperty = {
    value: 0,
    keyframes: [{ frame: 0, value: 0, easing: easeIn }, { frame: 10, value: 100 }],
  };
  const mid = valueAtFrame(p, 5);
  assert.ok(typeof mid === 'number' && mid < 30, `expected slow start, got ${mid}`);
});

test('multi-segment picks correct pair', () => {
  const p: StyleProperty = {
    value: 0,
    keyframes: [
      { frame: 0, value: 0 },
      { frame: 10, value: 100 },
      { frame: 20, value: 0 },
    ],
  };
  assert.equal(valueAtFrame(p, 15), 50);
});

test('hex colors lerp per channel', () => {
  const p: StyleProperty = {
    value: '#000000',
    unit: 'color',
    keyframes: [{ frame: 0, value: '#000000' }, { frame: 10, value: '#ffffff' }],
  };
  assert.equal(valueAtFrame(p, 5), '#808080');
});

test('non-interpolable strings step', () => {
  const p: StyleProperty = {
    value: '',
    keyframes: [{ frame: 0, value: 'left' }, { frame: 10, value: 'right' }],
  };
  assert.equal(valueAtFrame(p, 9), 'left');
  assert.equal(valueAtFrame(p, 10), 'right');
});

test('numberAtFrame falls back on missing prop and non-numbers', () => {
  assert.equal(numberAtFrame(undefined, 0, 7), 7);
  assert.equal(numberAtFrame({ value: 'x' }, 0, 7), 7);
  assert.equal(numberAtFrame({ value: 3 }, 0, 7), 3);
});
