/**
 * Cubic-bezier easing, CSS `cubic-bezier(p1x, p1y, p2x, p2y)` semantics:
 * maps progress x ∈ [0,1] to eased value via the curve
 * (0,0) — (p1x,p1y) — (p2x,p2y) — (1,1).
 */

import type { BezierEasing } from '@riposte/shared';

export type EaseFn = (x: number) => number;

export const linear: EaseFn = (x) => x;

const NEWTON_ITERATIONS = 8;
const NEWTON_MIN_SLOPE = 0.001;
const SUBDIVISION_PRECISION = 1e-7;
const SUBDIVISION_MAX_ITERATIONS = 12;

export function cubicBezier(e: BezierEasing): EaseFn {
  const { p1x, p1y, p2x, p2y } = e;
  if (p1x === p1y && p2x === p2y) return linear;

  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  const solveT = (x: number): number => {
    let t = x;
    for (let i = 0; i < NEWTON_ITERATIONS; i++) {
      const slope = sampleDX(t);
      if (Math.abs(slope) < NEWTON_MIN_SLOPE) break;
      t -= (sampleX(t) - x) / slope;
    }
    if (t >= 0 && t <= 1 && Math.abs(sampleX(t) - x) < SUBDIVISION_PRECISION) return t;

    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < SUBDIVISION_MAX_ITERATIONS; i++) {
      const cur = sampleX(t);
      if (Math.abs(cur - x) < SUBDIVISION_PRECISION) break;
      if (cur < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };

  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return sampleY(solveT(x));
  };
}
