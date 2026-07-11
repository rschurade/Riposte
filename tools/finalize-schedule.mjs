/**
 * Makes the imported Schedule scene BE the final v2 design instead of
 * reconstructing it at runtime:
 *  - DELETES the medal-era layers (_place/_gold/_silver/_bronze/_total/_flag 1-7)
 *  - adds the left side panel as REAL elements: _sideLogo image loader
 *    (placeholder logo) + _sideText1..3 texts, with fade in/out keyframes
 *  - sets the final content as design-time defaults (entries, title, Day 1)
 *  - composition action keeps ONLY the genuinely dynamic part: row
 *    re-spacing by entry count (rows untouched until the first update)
 *  - fills previewData so bench/script-preview show the on-air look
 *
 * Idempotent. Usage: node tools/finalize-schedule.mjs [sceneJsonPath]
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const file = process.argv[2] ?? 'projects/FIE_2026/scenes/FIE_2026_HD_Schedule_ext.json';
const LOGO_SRC = 'D:/projects/tristan/tv-grafik/TV-Grafik/abz/_FIE-Broadcast2026/files/Logos/logo_HK_white.png';
const LOGO_ASSET = 'assets/logo_HK_white.png';

const ENTRIES = [
  'Opening Ceremony',
  "Men's Foil individual Semi Finals",
  "Women's Epee individual Semi Finals",
  "Men's Foil individual Final",
  "Women's Epee individual Final",
  "Medal Ceremony Men's Foil",
  "Medal Ceremony Women's Epee",
];
const SIDE_TEXTS = ['FIE FENCING WORLD CHAMPIONSHIPS', 'Hong Kong, China', '22 - 30 July, 2026'];

const scene = JSON.parse(readFileSync(file, 'utf8'));
const comp = scene.composition;

// 1. delete medal-era layers for good
const DEAD_KEY = /^_(place|gold|silver|bronze|total|flag)[1-7]$/;
const before = comp.layers.length;
comp.layers = comp.layers.filter((l) => !DEAD_KEY.test(l.element.key ?? ''));
console.log(`deleted ${before - comp.layers.length} medal-era layers`);

// 2. design-time defaults: final content
for (let i = 1; i <= 7; i++) {
  const l = comp.layers.find((x) => x.element.key === `_entry${i}`);
  if (l) l.element.content = ENTRIES[i - 1] ?? '';
}
const lower = comp.layers.find((x) => x.element.key === '_lowerText');
if (lower) lower.element.content = 'Day 1';
const title = comp.layers.find((x) => x.element.key === '_title');
if (title) title.element.content = 'Schedule';

// 2b. bake the on-air row positions into the scene: on air rows ALWAYS came
// out of the relayout band (TOP 340..870), not the raw medal-counts band
// (404..900) — shift each row's layers so design-time equals on-air.
const RAW_TOP = 404, RAW_SPACING = (900 - 404) / 6;
const NEW_TOP = 340, NEW_SPACING = (870 - 340) / 6;
const shiftY = (style, delta) => {
  if (!style?.y) return;
  if (typeof style.y.value === 'number') style.y.value += delta;
  for (const k of style.y.keyframes ?? []) if (typeof k.value === 'number') k.value += delta;
};
const rowIdx = (y) => Math.max(0, Math.min(6, Math.round((y - RAW_TOP) / RAW_SPACING)));
const restY = (style) => {
  const kfs = style.y?.keyframes;
  return kfs?.length ? kfs[kfs.length - 1].value : style.y?.value ?? 0;
};
const entry1 = comp.layers.find((l) => l.element.key === '_entry1');
if (entry1 && restY(entry1.element.style) > 380) {
  const delta = (i) => (NEW_TOP + i * NEW_SPACING) - (RAW_TOP + i * RAW_SPACING);
  const plates = [], flours = [];
  for (const l of comp.layers) {
    const el = l.element, st = el.style;
    if (!st?.y) continue;
    const m = /^_entry([1-7])$/.exec(el.key ?? '');
    if (m) { shiftY(st, delta(Number(m[1]) - 1)); continue; }
    if (el.key) continue;
    const w = st.width?.value ?? 0;
    if (el.type === 'image' && w === 1920 && st.y.value < 500) plates.push(l);
    if (el.type === 'imageSequence' && w === 211) flours.push(l);
    if (el.type === 'rectangle' && w === 1538) shiftY(st, delta(rowIdx(restY(st))));
  }
  const bakeSorted = (list) => list
    .sort((a, b) => restY(a.element.style) - restY(b.element.style))
    .forEach((l, i) => {
      shiftY(l.element.style, delta(i));
      for (const mask of l.masks ?? []) shiftY(mask.style, delta(i));
    });
  bakeSorted(plates);
  bakeSorted(flours);
  console.log('row positions baked to on-air band (340..870)');
}

// 3. side panel as real elements (idempotent: replace previous versions)
comp.layers = comp.layers.filter((l) => !String(l.id).startsWith('side-'));
const FADE = {
  value: 1,
  keyframes: [
    { frame: 14, value: 0 },
    { frame: 24, value: 1, easing: { p1x: 0.25, p1y: 0.1, p2x: 0.25, p2y: 1 } },
    { frame: 50, value: 1 },
    { frame: 55, value: 0 },
  ],
};
const sideLayer = (id, element) => ({ id, name: id, startFrame: 0, duration: 75, element });
const sideText = (n, y, fontSize, content) => sideLayer(`side-text${n}`, {
  id: `side-text${n}-el`,
  key: `_sideText${n}`,
  type: 'text',
  content,
  fontFamily: 'League Spartan Medium',
  textAlign: 'center',
  multiline: true,
  style: {
    x: { value: 510 },
    y: { value: y },
    width: { value: 560 },
    height: { value: n === 1 ? 110 : 50 },
    fontSize: { value: fontSize },
    color: { value: '#ffffff', unit: 'color' },
    letterSpacing: { value: 1 },
    opacity: JSON.parse(JSON.stringify(FADE)),
    shadowX: { value: 0 },
    shadowY: { value: 2 },
    shadowBlur: { value: 6 },
    shadowColor: { value: 'rgba(0,0,0,0.4)' },
  },
});
comp.layers.push(
  sideLayer('side-logo', {
    id: 'side-logo-el',
    key: '_sideLogo',
    type: 'imageLoader',
    fit: 'contain',
    placeholder: LOGO_ASSET,
    style: {
      x: { value: 510 },
      y: { value: 470 },
      width: { value: 380 },
      height: { value: 270 },
      opacity: JSON.parse(JSON.stringify(FADE)),
    },
  }),
  sideText(1, 700, 38, SIDE_TEXTS[0]),
  sideText(2, 782, 32, SIDE_TEXTS[1]),
  sideText(3, 835, 29, SIDE_TEXTS[2]),
);

// 4. action: ONLY the dynamic row re-spacing (design untouched pre-update)
comp.action = `/* === Schedule dynamic rows (Riposte) === */
/* Rows bind to _entry1.._entry7. Until the first update() that mentions
   entries, the design-time layout stands. After that: empty entries hide
   their row and the rest re-space and center. Rows move via the LAYER
   wrapper (element + masks together), absolute deltas = idempotent. */
(function () {
  var ROWS = 7, ORIG_TOP = 340, ORIG_BOTTOM = 870;   /* = baked design band */
  var ORIG_SPACING = (ORIG_BOTTOM - ORIG_TOP) / (ROWS - 1);
  var TOP = 340, BOTTOM = 870;
  var SPACING = (BOTTOM - TOP) / (ROWS - 1);
  var OFF = 1400;
  var comp = this, rows = null;

  function lastY(st) {
    var p = st.y;
    if (p && p.keyframes && p.keyframes.length) return p.keyframes[p.keyframes.length - 1].value;
    return p ? p.value : 0;
  }
  function collect() {
    rows = []; for (var i = 0; i < ROWS; i++) rows.push([]);
    var plates = [], flours = [];
    comp.layers.forEach(function (L) {
      var el = L.doc.element, st = el.style;
      if (!st || !st.y) return;
      var key = el.key || '';
      var m = key.match(/^_entry([1-7])$/);
      if (m) { rows[parseInt(m[1], 10) - 1].push(L); return; }
      if (key) return;
      var w = st.width ? st.width.value : 0;
      if (el.type === 'image' && w === 1920 && st.y.value < 500) plates.push({ L: L, y: st.y.value });
      if (el.type === 'imageSequence' && w === 211) flours.push({ L: L, y: st.y.value });
      if (el.type === 'rectangle' && w === 1538) {
        var idx = Math.round((lastY(st) - ORIG_TOP) / ORIG_SPACING);
        rows[Math.max(0, Math.min(ROWS - 1, idx))].push(L);
      }
    });
    plates.sort(function (a, b) { return a.y - b.y; }).forEach(function (p, i) { if (i < ROWS) rows[i].push(p.L); });
    flours.sort(function (a, b) { return a.y - b.y; }).forEach(function (p, i) { if (i < ROWS) rows[i].push(p.L); });
  }
  function moveRow(i, d) { rows[i].forEach(function (L) { L.node.style.transform = d === 0 ? '' : 'translateY(' + d + 'px)'; }); }
  function relayout() {
    var touched = false;
    for (var i = 1; i <= ROWS; i++) if ('_entry' + i in loopic.templateData) touched = true;
    if (!touched) return;                      /* design-time layout stands */
    if (!rows) collect();
    var visible = [];
    for (var i = 0; i < ROWS; i++) {
      var t = (loopic.templateData['_entry' + (i + 1)] || '').toString().trim();
      if (t !== '') visible.push(i); else moveRow(i, OFF);
    }
    if (visible.length === 0) return;
    var startY = (TOP + BOTTOM) / 2 - (visible.length - 1) * SPACING / 2;
    visible.forEach(function (ri, slot) {
      moveRow(ri, (startY + slot * SPACING) - (ORIG_TOP + ri * ORIG_SPACING));
    });
  }
  var queued = false;
  loopic.useOnUpdate('*', function (k, v, next) {
    next();
    if (!queued) { queued = true; queueMicrotask(function () { queued = false; relayout(); }); }
  });
}).call(this);`;

// 5. preview data = the on-air payload for bench / script preview
scene.previewData = {
  _title: 'Schedule',
  _lowerText: 'Day 1',
  _sideLogo: LOGO_ASSET,
  _sideText1: SIDE_TEXTS[0],
  _sideText2: SIDE_TEXTS[1],
  _sideText3: SIDE_TEXTS[2],
};
ENTRIES.forEach((e, i) => (scene.previewData[`_entry${i + 1}`] = e));

if (existsSync(LOGO_SRC)) {
  copyFileSync(LOGO_SRC, file.replace(/scenes[\\/].*$/, '') + LOGO_ASSET);
  console.log('logo copied to set assets');
}

writeFileSync(file, JSON.stringify(scene, null, 2) + '\n');
console.log('Schedule finalized:', comp.layers.length, 'layers');
