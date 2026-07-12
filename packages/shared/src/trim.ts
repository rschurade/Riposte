/**
 * Duration trimming. Loopic imports carry the WORKSPACE duration, which is
 * often far longer than the content (250+ frames for an 85-frame graphic).
 * The dead tail squeezes the editor timeline and delays the runtime's
 * end-of-composition hide on air.
 */

import type { Composition, SceneElement } from './scene.ts';

/**
 * Last frame any content actually uses: markers, keyframes (elements and
 * masks), image-sequence frames, loop regions (+ exit fade). Layers without
 * any of these simply follow the composition and don't vote.
 */
export function contentEnd(comp: Composition): number {
  let end = 0;
  for (const m of comp.markers) end = Math.max(end, m.frame);
  const scanElement = (el: SceneElement, startFrame: number): void => {
    for (const prop of Object.values(el.style)) {
      for (const kf of prop?.keyframes ?? []) end = Math.max(end, kf.frame);
    }
    if (el.type === 'imageSequence') end = Math.max(end, startFrame + el.frames.length - 1);
  };
  for (const layer of comp.layers) {
    scanElement(layer.element, layer.startFrame);
    for (const mask of layer.masks ?? []) scanElement(mask, layer.startFrame);
    if (layer.loop) {
      end = Math.max(end, layer.startFrame + layer.loop.end + (layer.loop.exitFade ?? 15));
    }
  }
  return end;
}

/**
 * Shrink the composition to its content (+`pad` spare frames), clamping
 * layer spans that ran to the old end. Never grows. Returns the new
 * duration, or null when there is nothing to trim.
 */
export function trimToContent(comp: Composition, pad = 2): number | null {
  const target = contentEnd(comp) + pad;
  if (target < 2 || target >= comp.duration) return null;
  for (const layer of comp.layers) {
    if (layer.startFrame + layer.duration > target) {
      layer.duration = Math.max(1, target - layer.startFrame);
    }
  }
  comp.duration = target;
  return target;
}
