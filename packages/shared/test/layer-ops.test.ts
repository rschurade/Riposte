import assert from 'node:assert/strict';
import test from 'node:test';
import type { Layer } from '@riposte/shared';
import { shiftLayerKeyframeFrames } from '../src/index.ts';

test('moving a layer shifts element and mask keyframes without changing values', () => {
  const layer = {
    element: {
      style: {
        x: { value: 50, keyframes: [{ frame: 2, value: 10 }, { frame: 8, value: 20 }] },
        opacity: { value: 1, keyframes: [{ frame: 3, value: 0 }] },
      },
    },
    masks: [{ style: { y: { value: 25, keyframes: [{ frame: 4, value: 5 }, { frame: 9, value: 15 }] } } }],
  } as unknown as Layer;

  shiftLayerKeyframeFrames(layer, 7);

  assert.deepEqual(layer.element.style.x?.keyframes?.map((keyframe) => keyframe.frame), [9, 15]);
  assert.deepEqual(layer.element.style.opacity?.keyframes?.map((keyframe) => keyframe.frame), [10]);
  assert.deepEqual(layer.masks?.[0].style.y?.keyframes?.map((keyframe) => keyframe.frame), [11, 16]);
  assert.deepEqual(layer.element.style.x?.keyframes?.map((keyframe) => keyframe.value), [10, 20]);
  assert.equal(layer.element.style.x?.value, 50);
});

test('a zero-frame move is a no-op', () => {
  const layer = { element: { style: { x: { keyframes: [{ frame: 5, value: 10 }] } } } } as unknown as Layer;
  shiftLayerKeyframeFrames(layer, 0);
  assert.equal(layer.element.style.x?.keyframes?.[0].frame, 5);
});
