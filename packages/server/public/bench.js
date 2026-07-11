/* Riposte preview bench.
 *
 * URL params (all optional):
 *   ?set=demo&scene=Schedule   pick a scene
 *   &frame=60                  headless mode: apply data, show, seek, no play
 *   &data=<urlencoded payload> JSON or templateData XML applied before seek
 * window.__benchReady flips true when the frame is rendered (for screenshots).
 */
'use strict';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

let rt = null;
let scene = null;

async function listScenes() {
  const sets = await (await fetch('/api/sets')).json();
  const options = [];
  for (const s of sets) {
    for (const scenePath of s.scenes) {
      const name = scenePath.replace(/^scenes\//, '').replace(/\.json$/, '');
      options.push({
        root: s.root, set: s.name, scene: name, fonts: s.fonts,
        label: `${s.name} / ${name}`, value: `${s.root}/${s.name}/${name}`,
      });
    }
  }
  return options;
}

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

async function load(opt) {
  if (rt) { rt.destroy(); rt = null; }
  const base = `/${opt.root}/${opt.set}/`;
  await injectFonts(base, opt.fonts);
  scene = await (await fetch(`${base}scenes/${opt.scene}.json`)).json();
  rt = riposte.createRuntime(scene, $('stage'), { assetBase: base });
  window.rt = rt; // debugging convenience

  const comp = scene.composition;
  $('stage').style.width = comp.width + 'px';
  $('stage').style.height = comp.height + 'px';
  $('frameSlider').max = String(comp.duration - 1);
  fitStage();
  buildDataForm();
  seedRawData();
  tickFrameUi();
}

function fitStage() {
  if (!scene) return;
  if (params.has('bare')) {
    $('stage').style.transform = '';
    return;
  }
  const wrap = $('stageWrap');
  const comp = scene.composition;
  const scale = Math.min(wrap.clientWidth / comp.width, wrap.clientHeight / comp.height);
  $('stage').style.transform = `scale(${scale})`;
}

function sceneKeys() {
  const keys = [];
  for (const layer of scene.composition.layers) {
    if (layer.element && layer.element.key) keys.push(layer.element.key);
  }
  return keys;
}

function buildDataForm() {
  const form = $('dataForm');
  form.innerHTML = '';
  for (const key of sceneKeys()) {
    const label = document.createElement('label');
    label.textContent = key;
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.key = key;
    form.append(label, input);
  }
}

function seedRawData() {
  const parts = sceneKeys().map(
    (k) => `<componentData id="${k}"><data id="text" value=""/></componentData>`,
  );
  $('rawData').value = `<templateData>${parts.join('')}</templateData>`;
}

function sendForm() {
  const data = {};
  for (const input of $('dataForm').querySelectorAll('input')) {
    if (input.value !== '') data[input.dataset.key] = input.value;
  }
  rt.update(data);
}

function tickFrameUi() {
  if (rt) {
    const f = rt.composition.activeFrame;
    $('frameNum').textContent = `${f} / ${scene.composition.duration - 1}`;
    if (!sliderHeld) $('frameSlider').value = String(f);
  }
  requestAnimationFrame(tickFrameUi);
}

let sliderHeld = false;

async function main() {
  if (params.has('bare')) document.body.classList.add('bare');
  const options = await listScenes();
  const select = $('sceneSelect');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    select.append(opt);
  }
  const byValue = (v) => options.find((o) => o.value === v);

  const want = options.find(
    (o) =>
      (!params.get('set') || o.set === params.get('set')) &&
      (!params.get('scene') || o.scene === params.get('scene')),
  ) ?? options[0];
  if (!want) return;
  select.value = want.value;
  await load(want);

  select.addEventListener('change', () => void load(byValue(select.value)));
  $('btnPlay').addEventListener('click', () => rt.play());
  $('btnNext').addEventListener('click', () => rt.next());
  $('btnStop').addEventListener('click', () => rt.stop());
  $('btnReset').addEventListener('click', () => void load(byValue(select.value)));
  $('btnSendForm').addEventListener('click', sendForm);
  $('btnSendRaw').addEventListener('click', () => rt.update($('rawData').value));
  const slider = $('frameSlider');
  slider.addEventListener('pointerdown', () => (sliderHeld = true));
  slider.addEventListener('pointerup', () => (sliderHeld = false));
  slider.addEventListener('input', () => {
    rt.composition.pause();
    rt.composition.goTo(Number(slider.value));
    // scrubbing implies wanting to see the frame even before play()
    document.querySelector('.riposte-comp').style.visibility = 'visible';
  });
  window.addEventListener('resize', fitStage);

  // Headless screenshot mode
  if (params.has('frame')) {
    const raw = params.get('data');
    if (raw) rt.update(raw);
    document.querySelector('.riposte-comp').style.visibility = 'visible';
    rt.composition.goTo(Number(params.get('frame')));
    await (document.fonts ? document.fonts.ready : Promise.resolve());
    await new Promise((r) => setTimeout(r, 400)); // let images decode
    if (params.has('probe')) {
      const el = document.querySelector(`[data-key="${params.get('probe')}"]`);
      const pre = document.createElement('pre');
      pre.id = 'probe';
      pre.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden';
      pre.textContent = JSON.stringify({
        rect: el ? el.getBoundingClientRect() : null,
        inner: [innerWidth, innerHeight],
        dpr: devicePixelRatio,
      });
      document.body.appendChild(pre);
    }
    window.__benchReady = true;
  }
}

void main();
