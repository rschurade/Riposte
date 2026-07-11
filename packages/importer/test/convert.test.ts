import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertComposition, type AssetResolver } from '../src/convert.ts';
import type { LooComposition } from '../src/loo-format.ts';

const resolver: AssetResolver = {
  image: async (id) => `assets/${id}.png`,
  sequenceFrames: async (_id, imageIds) => imageIds.map((i) => `assets/seq/${i}.png`),
};

function baseComp(over: Partial<LooComposition>): LooComposition {
  return {
    id: 'c1',
    name: 'Test',
    width: 1920,
    height: 1080,
    fps: 50,
    duration: 75,
    workspaceDuration: 250,
    layers: [],
    ...over,
  };
}

test('workspaceDuration wins over duration (export semantics)', async () => {
  const { scene } = await convertComposition(baseComp({}), resolver);
  assert.equal(scene.composition.duration, 250);
});

test('pause/outro/action markers from Loopic frame actions', async () => {
  const { scene } = await convertComposition(
    baseComp({
      actions: [
        { id: 'a', frame: 50, code: 'this.pause();', asOutro: true },
        { id: 'b', frame: 10, code: 'console.log(1)' },
      ],
    }),
    resolver,
  );
  assert.deepEqual(scene.composition.markers, [
    { frame: 10, type: 'action', source: 'console.log(1)' },
    { frame: 50, type: 'pause' },
    { frame: 50, type: 'outro' },
  ]);
});

function textLayer() {
  return {
    id: 'l1',
    name: 'text',
    startFrame: 14,
    duration: 42,
    element: {
      id: 'e1',
      key: '_t',
      type: 'TEXT',
      content: 'Hi',
      transformProperties: {
        x: { value: 93, keyframes: [] },
        y: { value: 327, keyframes: [] },
        opacity: {
          value: 1,
          keyframes: [
            { frame: 1, value: 0 },
            { frame: 3, value: 1 },
          ],
        },
      },
      sizeProperties: { width: { value: 252 }, height: { value: 44 } },
      transformOrigin: { x: { value: -525 }, y: { value: 0 } },
      textProperties: { fontFamily: { value: 'League Spartan' }, fontSize: { value: 30 } },
    },
  };
}

test('keyframes shift from layer-local to composition-global frames', async () => {
  const { scene } = await convertComposition(baseComp({ layers: [textLayer()] }), resolver);
  const op = scene.composition.layers[0]!.element.style.opacity!;
  assert.deepEqual(
    op.keyframes!.map((k) => k.frame),
    [15, 17],
  );
});

test('transform origin: x/y anchor converts to element center', async () => {
  const { scene } = await convertComposition(baseComp({ layers: [textLayer()] }), resolver);
  const s = scene.composition.layers[0]!.element.style;
  assert.equal(s.x.value, 93 + 525); // center = x - origin.x
  assert.equal(s.y.value, 327);
});

test('layer order is preserved (Loopic is bottom-first like Riposte)', async () => {
  const a = { ...textLayer(), id: 'A' };
  const b = { ...textLayer(), id: 'B' };
  const { scene } = await convertComposition(baseComp({ layers: [a, b] }), resolver);
  assert.deepEqual(
    scene.composition.layers.map((l) => l.id),
    ['A', 'B'],
  );
});

test('linear easing is dropped, non-linear kept', async () => {
  const layer = textLayer();
  layer.element.transformProperties!.opacity!.keyframes = [
    { frame: 0, value: 0, easing: { p1x: 0.5, p1y: 0.5, p2x: 0.7, p2y: 0.7 } },
    { frame: 5, value: 1, easing: { p1x: 0.25, p1y: 0.1, p2x: 0.25, p2y: 1 } },
  ];
  const { scene } = await convertComposition(baseComp({ layers: [layer] }), resolver);
  const kfs = scene.composition.layers[0]!.element.style.opacity!.keyframes!;
  assert.equal(kfs[0]!.easing, undefined);
  assert.deepEqual(kfs[1]!.easing, { p1x: 0.25, p1y: 0.1, p2x: 0.25, p2y: 1 });
});
