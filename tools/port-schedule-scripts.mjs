/**
 * Ports the two hand-written script blocks of FIE_2026_HD_Schedule_ext.html
 * (dynamic 5/7-row relayout + v2 side panel) into the imported scene's
 * composition action, translated from Loopic's live-Property API to the
 * Riposte runtime API (composition.layers handles + useOn* middlewares).
 *
 * Idempotent: skips if the port marker is already present.
 * Usage: node tools/port-schedule-scripts.mjs [sceneJsonPath]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2] ?? 'projects/FIE_2026/scenes/FIE_2026_HD_Schedule_ext.json';
const MARKER = '/* === Riposte port: Schedule dynamic rows + side panel === */';

const scene = JSON.parse(readFileSync(file, 'utf8'));
// re-runnable: replace an existing port with the current version
const existing = scene.composition.action ?? '';
const idx = existing.indexOf(MARKER);
if (idx >= 0) scene.composition.action = existing.slice(0, idx).trimEnd();

const PORT = `
${MARKER}
/* Rows bind to _entry1.._entry7. Empty entries hide their row (bar, plate,
   flourish) and the remaining rows are re-spaced and vertically centered.
   Rows are moved by transforming the LAYER wrapper (element + masks together)
   with absolute deltas — idempotent across repeated updates. */
(function () {
  var ROWS = 7, ORIG_TOP = 404, ORIG_BOTTOM = 900;
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
      var m = key.match(/^_(entry|flag|place|gold|silver|bronze|total)([1-7])$/);
      if (m) {
        if (m[1] === 'entry') rows[parseInt(m[2], 10) - 1].push(L);
        /* medal-era leftovers: visibility, NOT display — the runtime rewrites
           display on every frame for the layer time-window */
        else L.node.style.visibility = 'hidden';
        return;
      }
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
  function moveRow(i, d) { rows[i].forEach(function (L) { L.node.style.transform = 'translateY(' + d + 'px)'; }); }
  function relayout() {
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
  relayout();
}).call(this);

/* v2 left side: configurable logo (_sideLogo = image path) + _sideText1..3.
   Overlay lives inside the composition root so it scales with any host.
   Fades in 600ms after play, out on next(), hides on stop(). */
(function () {
  var comp = this, el = null, t1, t2, t3;
  function root() { return comp.layers[0] ? comp.layers[0].node.parentElement : document.body; }
  function build() {
    if (el) return;
    var css = document.createElement('style');
    css.textContent =
      '#fvSide{position:absolute;left:210px;top:330px;width:600px;height:540px;' +
      'display:flex;flex-direction:column;justify-content:center;align-items:center;' +
      'opacity:0;transition:opacity .45s ease;z-index:99999;pointer-events:none;text-align:center;' +
      "font-family:'League Spartan Medium','League Spartan',sans-serif;color:#fff;}" +
      '#fvLogo{display:block;height:250px;filter:drop-shadow(0 4px 12px rgba(0,0,0,.35));}' +
      '#fvT1{margin-top:48px;font-size:38px;letter-spacing:1px;text-shadow:0 2px 6px rgba(0,0,0,.4);}' +
      '#fvT2{margin-top:14px;font-size:32px;opacity:.95;text-shadow:0 2px 6px rgba(0,0,0,.4);}' +
      '#fvT3{margin-top:10px;font-size:29px;opacity:.9;text-shadow:0 2px 6px rgba(0,0,0,.4);}';
    document.head.appendChild(css);
    el = document.createElement('div');
    el.id = 'fvSide';
    el.innerHTML = '<img id="fvLogo" src="" alt="" style="display:none">' +
      '<div id="fvT1"></div><div id="fvT2"></div><div id="fvT3"></div>';
    root().appendChild(el);
    t1 = el.querySelector('#fvT1'); t2 = el.querySelector('#fvT2'); t3 = el.querySelector('#fvT3');
    applyData();
  }
  function applyData() {
    if (!el) return;
    var logo = el.querySelector('#fvLogo');
    var path = (loopic.templateData._sideLogo || '').toString();
    if (path) { logo.src = path; logo.style.display = 'block'; } else { logo.style.display = 'none'; }
    t1.textContent = (loopic.templateData._sideText1 || '').toString();
    t2.textContent = (loopic.templateData._sideText2 || '').toString();
    t3.textContent = (loopic.templateData._sideText3 || '').toString();
  }
  function show() { build(); el.style.opacity = '1'; }
  function hide() { if (el) el.style.opacity = '0'; }
  loopic.useOnUpdate('*', function (k, v, next) { next(); build(); applyData(); });
  loopic.useOnPlay(function (next) { next(); setTimeout(show, 600); });
  loopic.useOnNext(function (next) { next(); hide(); });
  loopic.useOnStop(function (next) { next(); hide(); });
  window.__fvSide = { show: show, hide: hide };
}).call(this);
`;

scene.composition.action = ((scene.composition.action ?? '') + '\n' + PORT).trim();
writeFileSync(file, JSON.stringify(scene, null, 2) + '\n');
console.log('ported Schedule scripts into', file);
