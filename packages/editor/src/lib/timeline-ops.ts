import type { ElementStyle, Layer } from '@riposte/shared';

/** Shift every element and mask keyframe in composition time. */
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
