/* Riposte playout — the browser side of the virtual CasparCG.
 *
 * Subscribes to /api/events and renders the AMCP CG traffic of one feed and
 * one channel as stacked layers, each driven by the real runtime. Media-layer
 * PLAY/CLEAR commands show as chips (clips are a playout concern, not a
 * template concern).
 *
 * URL params: ?feed=main|preview (default main), &chan=1 (default 1).
 * Open one window per output to mirror a production rig.
 */
'use strict';

const params = new URLSearchParams(location.search);
const FEED = params.get('feed') || 'main';
const CHAN = Number(params.get('chan') || '1');
const W = 1920;
const H = 1080;

document.getElementById('feedLabel').textContent = `${FEED} · ch ${CHAN}`;

const stage = document.getElementById('stage');
stage.style.width = W + 'px';
stage.style.height = H + 'px';

function fit() {
  const scale = Math.min(innerWidth / W, innerHeight / H);
  stage.style.transform = `scale(${scale})`;
  stage.style.left = (innerWidth - W * scale) / 2 + 'px';
  stage.style.top = (innerHeight - H * scale) / 2 + 'px';
}
addEventListener('resize', fit);
fit();

// ---- console ----------------------------------------------------------------
const consoleEl = document.getElementById('console');
document.getElementById('btnConsole').onclick = () => consoleEl.classList.toggle('open');
addEventListener('keydown', (e) => {
  if (e.key === '`') consoleEl.classList.toggle('open');
});

function logLine(text, cls) {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = text;
  consoleEl.append(div);
  while (consoleEl.childElementCount > 300) consoleEl.firstElementChild.remove();
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

// ---- fonts (shared cache across layers) --------------------------------------
const injectedFonts = new Set();
async function injectFonts(baseUrl, fonts) {
  for (const f of fonts || []) {
    if (injectedFonts.has(f.family)) continue;
    injectedFonts.add(f.family);
    const face = new FontFace(f.family, `url("${baseUrl}${f.file}")`);
    try {
      await face.load();
      document.fonts.add(face);
    } catch (err) {
      console.warn('font load failed', f.family, err);
    }
  }
}

// ---- CG layers ----------------------------------------------------------------
/** key "layer:cgLayer" → { el, rt, template, gen } */
const layers = new Map();
window.__layers = layers; // debugging/testing handle

function layerCountUi() {
  const n = layers.size;
  document.getElementById('layerCount').textContent = n ? `${n} layer${n > 1 ? 's' : ''}` : 'idle';
}

function destroyLayer(key) {
  const l = layers.get(key);
  if (!l) return;
  try { if (l.rt) l.rt.destroy(); } catch { /* already broken */ }
  l.el.remove();
  layers.delete(key);
  layerCountUi();
}

async function addLayer(ev) {
  const key = `${ev.layer}:${ev.cgLayer}`;
  destroyLayer(key);
  const el = document.createElement('div');
  el.className = 'cglayer';
  el.style.width = W + 'px';
  el.style.height = H + 'px';
  el.style.zIndex = String(ev.layer * 100 + ev.cgLayer);
  stage.append(el);
  const entry = { el, rt: null, template: ev.template, gen: (addLayer.gen = (addLayer.gen || 0) + 1) };
  layers.set(key, entry);
  layerCountUi();

  const base = `/${ev.ref.root}/${ev.ref.set}/`;
  try {
    await injectFonts(base, ev.ref.fonts);
    const scene = await (await fetch(`${base}scenes/${ev.ref.scene}.json`)).json();
    const components = {};
    for (const f of ev.ref.components || []) {
      try { components[f] = await (await fetch(base + f)).json(); } catch { /* missing */ }
    }
    // a newer ADD/REMOVE for this key may have won while we fetched
    if (layers.get(key) !== entry) { el.remove(); return; }
    entry.rt = riposte.createRuntime(scene, el, { assetBase: base, components });
    if (ev.data) entry.rt.update(ev.data);
    if (ev.playOnLoad) entry.rt.play();
  } catch (err) {
    logLine(`load failed for "${ev.template}": ${err}`, 'err');
    if (layers.get(key) === entry) destroyLayer(key);
  }
}

function onCg(ev) {
  if (ev.chan !== CHAN) return;
  const key = `${ev.layer}:${ev.cgLayer}`;
  const l = layers.get(key);
  switch (ev.action) {
    case 'add': ev.ref ? void addLayer(ev) : logLine(`template not found: "${ev.template}"`, 'err'); break;
    case 'update': if (l && l.rt && ev.data) l.rt.update(ev.data); break;
    case 'play': if (l && l.rt) l.rt.play(); break;
    case 'next': if (l && l.rt) l.rt.next(); break;
    case 'stop': if (l && l.rt) l.rt.stop(); break;
    case 'invoke': if (l && l.rt && ev.data) l.rt.invoke(ev.data); break;
    case 'remove': case 'clear': destroyLayer(key); break;
  }
}

// ---- media chips ---------------------------------------------------------------
const mediaEl = document.getElementById('media');
const chips = new Map(); // "layer" → chip element

function onMedia(ev) {
  if (ev.chan !== undefined && ev.chan !== CHAN) return;
  if (ev.cmd === 'PLAY' && ev.layer !== undefined) {
    let chip = chips.get(ev.layer);
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'chip';
      mediaEl.append(chip);
      chips.set(ev.layer, chip);
    }
    chip.textContent = `▶ ${CHAN}-${ev.layer}  ${ev.clip || ''}`;
  } else if (ev.cmd === 'CLEAR') {
    if (ev.layer !== undefined) {
      chips.get(ev.layer)?.remove();
      chips.delete(ev.layer);
    } else {
      // whole channel: media chips and CG layers alike
      for (const chip of chips.values()) chip.remove();
      chips.clear();
      for (const key of [...layers.keys()]) destroyLayer(key);
    }
  }
}

// ---- SSE ------------------------------------------------------------------------
const dot = document.getElementById('connDot');
const es = new EventSource('/api/events');
es.addEventListener('amcp', (msg) => {
  const ev = JSON.parse(msg.data);
  if (ev.feed !== FEED) return;
  if (ev.kind === 'conn') {
    dot.classList.toggle('on', ev.state === 'connected');
    logLine(`${ev.state}: ${ev.peer}`, 'conn');
  } else {
    logLine(ev.raw, 'in');
    if (ev.kind === 'cg') onCg(ev);
    else if (ev.kind === 'media') onMedia(ev);
  }
});
es.onerror = () => dot.classList.remove('on');

logLine(`riposte playout — feed "${FEED}", channel ${CHAN}. Point ControlCenter's ${FEED.toUpperCase()} output at this machine, port ${FEED === 'preview' ? 6251 : 6250}.`, 'conn');
window.__playoutReady = true;
