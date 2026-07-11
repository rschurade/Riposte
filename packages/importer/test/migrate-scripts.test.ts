import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Layer, SceneDoc, SceneElement, TextElement } from '@riposte/shared';
import { cleanupLayerNames, migrateSceneScripts, restructureHoldLayers } from '../src/migrate-scripts.ts';

function textEl(id: string, key?: string): TextElement {
  return { id, key, type: 'text', content: '', style: { x: { value: 0 }, y: { value: 0 } } };
}

function layer(el: SceneElement, opts: Partial<Layer> = {}): Layer {
  return { id: `L-${el.id}`, name: el.id, startFrame: 0, duration: 100, element: el, ...opts };
}

function doc(layers: Layer[], action: string): SceneDoc {
  return {
    formatVersion: 1,
    name: 'test',
    composition: { width: 1920, height: 1080, fps: 50, duration: 100, markers: [{ frame: 40, type: 'pause' }], layers, action },
  };
}

const SWITCH_BLOCK = `loopic.useOnUpdate("_lampSwitch", (key, value, next) => {
  const element = this.findElementByKey("_lamp");
  if(value === "0") {
    element.domNode.style.visibility = "hidden";
  } else {
    element.domNode.style.visibility = "visible";
  }
  next();
})`;

test('switch pattern becomes a default hideWhen binding', () => {
  const lamp = textEl('lamp', '_lamp');
  const d = doc([layer(lamp)], SWITCH_BLOCK);
  const r = migrateSceneScripts(d);
  assert.equal(r.changed, true);
  assert.deepEqual(lamp.visibility, { bindKey: '_lampSwitch' }); // hideWhen ["0"] is the default
  assert.equal(d.composition.action, undefined);
});

test('useOnPlay hide folds into initial:hidden', () => {
  const lamp = textEl('lamp', '_lamp');
  const action = `loopic.useOnPlay((next) => {
    this.findElementByKey("_lamp").domNode.style.visibility = "hidden";
    next();
  });\n${SWITCH_BLOCK}`;
  const d = doc([layer(lamp)], action);
  migrateSceneScripts(d);
  assert.deepEqual(lamp.visibility, { bindKey: '_lampSwitch', initial: 'hidden' });
  assert.equal(d.composition.action, undefined);
});

test('switch statement becomes per-element showWhen lists', () => {
  const yellow = textEl('y', '_yP');
  const red = textEl('r', '_rP');
  const action = `loopic.useOnUpdate("_pCard", (key, value, next) => {
    const a = this.findElementByKey("_yP");
    const b = this.findElementByKey("_rP");
    switch(value) {
      case "0": a.domNode.style.visibility = "hidden"; b.domNode.style.visibility = "hidden"; break;
      case "1": a.domNode.style.visibility = "visible"; b.domNode.style.visibility = "hidden"; break;
      case "2": a.domNode.style.visibility = "visible"; b.domNode.style.visibility = "visible"; break;
    }
    next();
  })`;
  const d = doc([layer(yellow), layer(red)], action);
  migrateSceneScripts(d);
  assert.deepEqual(yellow.visibility, { bindKey: '_pCard', showWhen: ['1', '2'] });
  assert.deepEqual(red.visibility, { bindKey: '_pCard', showWhen: ['2'] });
});

test('setContent redirect renames the element key', () => {
  const score = textEl('s', '_scoreZZ');
  const action = `loopic.useOnUpdate("_score", (key, value, next) => {
    this.findElementByKey("_scoreZZ").setContent(value);
    next();
  })`;
  const d = doc([layer(score)], action);
  migrateSceneScripts(d);
  assert.equal(score.key, '_score');
  assert.equal(d.composition.action, undefined);
});

test('unrecognized code survives untouched while known blocks convert', () => {
  const lamp = textEl('lamp', '_lamp');
  const custom = `useOnUpdate("*", (key, value, next) => { relayoutRows(); next(); });`;
  const d = doc([layer(lamp)], `${SWITCH_BLOCK};\n${custom}`);
  const r = migrateSceneScripts(d);
  assert.equal(r.changed, true);
  assert.deepEqual(lamp.visibility, { bindKey: '_lampSwitch' });
  assert.equal(d.composition.action, custom);
});

test('handler touching only missing elements is removed as dead code', () => {
  const d = doc([layer(textEl('other', '_other'))], SWITCH_BLOCK);
  const r = migrateSceneScripts(d);
  assert.equal(r.changed, true);
  assert.equal(d.composition.action, undefined);
  assert.ok(r.notes.some((n) => n.includes('dead handler removed')));
});

test('handler with real logic (non-verbatim setContent) is kept', () => {
  const el = textEl('t', '_target');
  const action = `loopic.useOnUpdate("_x", (key, value, next) => {
    this.findElementByKey("_target").setContent(value.toUpperCase());
    next();
  })`;
  const d = doc([layer(el)], action);
  const r = migrateSceneScripts(d);
  assert.equal(r.changed, false);
  assert.equal(d.composition.action, action);
});

test('migration is idempotent', () => {
  const lamp = textEl('lamp', '_lamp');
  const d = doc([layer(lamp)], SWITCH_BLOCK);
  migrateSceneScripts(d);
  const r2 = migrateSceneScripts(d);
  assert.equal(r2.changed, false);
});

test('cleanupLayerNames drops junk and key-duplicating names, keeps human ones', () => {
  const a = layer(textEl('a', '_lamp'), { name: 'New layer' });
  const b = layer(textEl('b', '_score'), { name: 'Copy of Copy of New layer 2' });
  const c = layer(textEl('c', '_noc'), { name: '_noc' });
  const d = layer(textEl('d'), { name: 'Background plate' });
  const e = layer(textEl('e'), { name: 'Layer 3' });
  const r = cleanupLayerNames(doc([a, b, c, d, e], ''));
  assert.equal(r.changed, true);
  assert.equal(a.name, undefined);
  assert.equal(b.name, undefined);
  assert.equal(c.name, undefined);
  assert.equal(d.name, 'Background plate');
  assert.equal(e.name, undefined);
  assert.equal(cleanupLayerNames(doc([a, b, c, d, e], '')).changed, false); // idempotent
});

test('restructureHoldLayers extends bound hold layers with the sibling fade', () => {
  const lamp = textEl('lamp', '_lamp');
  lamp.visibility = { bindKey: '_lampSwitch', initial: 'hidden' };
  const donor = textEl('name', '_name');
  donor.style.opacity = {
    value: 1,
    keyframes: [
      { frame: 20, value: 0 },
      { frame: 23, value: 1 },
      { frame: 45, value: 1 },
      { frame: 50, value: 0 },
    ],
  };
  const holdLayer = layer(lamp, { startFrame: 39, duration: 2 });
  const d = doc([layer(donor, { startFrame: 20, duration: 80 }), holdLayer], '');
  const r = restructureHoldLayers(d);
  assert.equal(r.changed, true);
  assert.equal(holdLayer.startFrame, 20);
  assert.equal(holdLayer.duration, 80);
  assert.deepEqual(
    lamp.style.opacity?.keyframes?.map((k) => k.frame),
    [20, 23, 45, 50],
  );
  // unbound or already-animated layers stay put
  const r2 = restructureHoldLayers(d);
  assert.equal(r2.changed, false);
});
