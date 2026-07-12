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

// ---- media path rewriting --------------------------------------------------------
/** ControlCenter sends absolute disk paths for flags/logos (real Caspar's CEF
 * loads them from disk). A browser can't — route them through the server. */
function rewriteMediaPaths(data) {
  if (!data) return data;
  return data.replace(
    /(?:file:\/{2,3})?((?:[A-Za-z]:|\\\\)[^"'<>\n]*?\.(?:png|jpe?g|webp|gif|svg|bmp))/gi,
    (_, p) => '/api/mediafile?p=' + encodeURIComponent(p.replace(/\\\\/g, '\\')),
  );
}

// ---- AMCP port (display + configure) ----------------------------------------------
const portBtn = document.getElementById('portBtn');
let amcpState = null;

function portUi() {
  const s = amcpState?.[FEED];
  if (!s) {
    portBtn.textContent = 'port ?';
    return;
  }
  portBtn.textContent = `${location.hostname}:${s.port}`;
  portBtn.classList.toggle('err', !s.listening);
  portBtn.title = s.listening
    ? `Point ControlCenter's ${FEED.toUpperCase()} output (or any Caspar client) at this address.\nClick to change the port.`
    : `NOT LISTENING on ${s.port}: ${s.error || 'unknown error'}\nClick to change the port.`;
}

async function loadPorts() {
  try {
    amcpState = await (await fetch('/api/amcp')).json();
  } catch {
    amcpState = null;
  }
  portUi();
  const s = amcpState?.[FEED];
  if (s) {
    logLine(
      s.listening
        ? `riposte playout — feed "${FEED}", channel ${CHAN}. Point ControlCenter's ${FEED.toUpperCase()} output at ${location.hostname}:${s.port}.`
        : `feed "${FEED}" is NOT listening on ${s.port}: ${s.error || 'unknown error'}`,
      s.listening ? 'conn' : 'err',
    );
  }
}

portBtn.onclick = async () => {
  const cur = amcpState?.[FEED]?.port ?? '';
  const v = prompt(`AMCP port for the "${FEED}" feed — ControlCenter's ${FEED.toUpperCase()} output connects here:`, cur);
  if (!v || Number(v) === cur) return;
  const res = await fetch('/api/amcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [FEED]: Number(v) }),
  });
  const r = await res.json();
  if (!res.ok) {
    logLine(`port change failed: ${r.error || res.status}`, 'err');
    consoleEl.classList.add('open');
    return;
  }
  amcpState = r;
  portUi();
  const s = amcpState[FEED];
  logLine(s.listening ? `amcp "${FEED}" now listening on ${s.port} — reconnect the client` : `amcp "${FEED}" failed to bind ${s.port}: ${s.error}`, s.listening ? 'conn' : 'err');
};

// ---- debug probe (?debug=_time) ---------------------------------------------------
// Prints the probed element's measured geometry into the command console on
// every update — the ground truth for "is it actually moving, and is digit
// boxing active in THIS tab".
const DEBUG_KEY = params.get('debug');
if (DEBUG_KEY) consoleEl.classList.add('open');

function debugProbe() {
  const n = stage.querySelector(`[data-key="${CSS.escape(DEBUG_KEY)}"]`);
  if (!n) {
    logLine(`dbg ${DEBUG_KEY}: element not found in any layer`, 'err');
    return;
  }
  const span = n.querySelector('span');
  if (!span) return;
  const r = span.getBoundingClientRect();
  const boxes = span.querySelectorAll('span').length;
  const fam = getComputedStyle(n).fontFamily.split(',')[0].replace(/"/g, '');
  const size = getComputedStyle(n).fontSize;
  const loaded = document.fonts.check(`${size} ${getComputedStyle(n).fontFamily}`);
  logLine(
    `dbg ${DEBUG_KEY}: "${span.textContent}" left=${r.left.toFixed(1)} width=${r.width.toFixed(1)} digitBoxes=${boxes} font=${fam}@${size} loaded=${loaded}`,
    boxes > 0 ? 'conn' : 'err',
  );
}

// ---- SSE ------------------------------------------------------------------------
const dot = document.getElementById('connDot');
const es = new EventSource('/api/events');
es.addEventListener('amcp', (msg) => {
  const ev = JSON.parse(msg.data);
  if (ev.kind === 'ports') {
    // not feed-scoped: port changes announce the full state to every window
    amcpState = ev.state;
    portUi();
    return;
  }
  if (ev.feed !== FEED) return;
  if (ev.kind === 'conn') {
    dot.classList.toggle('on', ev.state === 'connected');
    logLine(`${ev.state}: ${ev.peer}`, 'conn');
  } else {
    logLine(ev.raw, 'in');
    if (ev.data) ev.data = rewriteMediaPaths(ev.data);
    if (ev.kind === 'cg') onCg(ev);
    else if (ev.kind === 'media') onMedia(ev);
    if (DEBUG_KEY && ev.kind === 'cg' && ev.action === 'update') debugProbe();
  }
});
es.onerror = () => dot.classList.remove('on');

void loadPorts();
window.__playoutReady = true;
