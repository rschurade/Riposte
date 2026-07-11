import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cubicBezier, linear } from '../src/bezier.ts';

test('linear passthrough', () => {
  assert.equal(linear(0.25), 0.25);
});

test('identity control points collapse to linear', () => {
  const f = cubicBezier({ p1x: 0.3, p1y: 0.3, p2x: 0.7, p2y: 0.7 });
  assert.equal(f, linear);
});

test('clamps outside [0,1]', () => {
  const f = cubicBezier({ p1x: 0.42, p1y: 0, p2x: 0.58, p2y: 1 });
  assert.equal(f(-1), 0);
  assert.equal(f(2), 1);
});

test('ease-in-out is symmetric and monotonic', () => {
  const f = cubicBezier({ p1x: 0.42, p1y: 0, p2x: 0.58, p2y: 1 });
  assert.ok(Math.abs(f(0.5) - 0.5) < 1e-4);
  assert.ok(f(0.25) < 0.25); // slow start
  assert.ok(f(0.75) > 0.75); // fast end
  let prev = 0;
  for (let x = 0; x <= 1.0001; x += 0.01) {
    const y = f(x);
    assert.ok(y >= prev - 1e-9, `monotonic at ${x}`);
    prev = y;
  }
});

test('matches known CSS ease curve samples', () => {
  // cubic-bezier(0.25, 0.1, 0.25, 1.0) = CSS "ease"; reference values from browsers
  const f = cubicBezier({ p1x: 0.25, p1y: 0.1, p2x: 0.25, p2y: 1 });
  assert.ok(Math.abs(f(0.5) - 0.8024) < 0.002, `f(0.5)=${f(0.5)}`);
});
