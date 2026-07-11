/**
 * Value of a style property at a frame.
 *
 * Loopic-compatible semantics (kept for import fidelity): when keyframes
 * exist, the static `value` is IGNORED. Easing on a keyframe applies toward
 * the NEXT keyframe; linear when omitted. Numbers interpolate; #rrggbb(aa)
 * colors lerp per channel; other strings step.
 */

import type { Keyframe, StyleProperty, StyleValue } from '@riposte/shared';
import { cubicBezier, linear, type EaseFn } from './bezier.ts';

const easeCache = new WeakMap<Keyframe, EaseFn>();

function easeOf(k: Keyframe): EaseFn {
  if (!k.easing) return linear;
  let fn = easeCache.get(k);
  if (!fn) {
    fn = cubicBezier(k.easing);
    easeCache.set(k, fn);
  }
  return fn;
}

const HEX_RE = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;

function lerpColor(a: string, b: string, t: number): string | null {
  const ma = HEX_RE.exec(a);
  const mb = HEX_RE.exec(b);
  if (!ma || !mb) return null;
  const pa = parseInt(ma[1]!, 16);
  const pb = parseInt(mb[1]!, 16);
  const ch = (x: number, shift: number) => (x >> shift) & 0xff;
  const mix = (x: number, y: number) => Math.round(x + (y - x) * t);
  const r = mix(ch(pa, 16), ch(pb, 16));
  const g = mix(ch(pa, 8), ch(pb, 8));
  const bl = mix(ch(pa, 0), ch(pb, 0));
  const aa = ma[2] ? parseInt(ma[2], 16) : 255;
  const ab = mb[2] ? parseInt(mb[2], 16) : 255;
  const al = mix(aa, ab);
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(bl)}${al === 255 ? '' : hex(al)}`;
}

export function valueAtFrame(prop: StyleProperty, frame: number): StyleValue {
  const kfs = prop.keyframes;
  if (!kfs || kfs.length === 0) return prop.value;
  const first = kfs[0]!;
  if (kfs.length === 1 || frame <= first.frame) return first.value;
  const last = kfs[kfs.length - 1]!;
  if (frame >= last.frame) return last.value;

  let i = 0;
  while (i < kfs.length - 1 && kfs[i + 1]!.frame <= frame) i++;
  const k1 = kfs[i]!;
  const k2 = kfs[i + 1]!;
  if (k2.frame === k1.frame) return k2.value;

  const t = easeOf(k1)((frame - k1.frame) / (k2.frame - k1.frame));

  if (typeof k1.value === 'number' && typeof k2.value === 'number') {
    return k1.value + (k2.value - k1.value) * t;
  }
  if (typeof k1.value === 'string' && typeof k2.value === 'string') {
    const c = lerpColor(k1.value, k2.value, t);
    if (c !== null) return c;
  }
  return k1.value; // non-interpolable: step until next keyframe
}

/** Numeric convenience — NaN-safe fallback for props that must be numbers. */
export function numberAtFrame(prop: StyleProperty | undefined, frame: number, fallback: number): number {
  if (!prop) return fallback;
  const v = valueAtFrame(prop, frame);
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
