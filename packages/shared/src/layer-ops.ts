import type { ElementStyle, Layer } from './scene.ts';

/**
 * Shift every element and mask keyframe of a layer by `delta` scene frames.
 * Keyframes are stored in ABSOLUTE frames, so moving a layer's span (the
 * timeline bar) must carry them along or the animation desyncs from the
 * span — the After Effects / Loopic model. Values and easing are untouched.
 */
export function shiftLayerKeyframeFrames(layer: Layer, delta: number): void {
  if (delta === 0) return;
  const shiftStyle = (style: ElementStyle): void => {
    for (const property of Object.values(style)) {
      for (const keyframe of property?.keyframes ?? []) keyframe.frame += delta;
    }
  };
  shiftStyle(layer.element.style);
  for (const mask of layer.masks ?? []) shiftStyle(mask.style);
}
