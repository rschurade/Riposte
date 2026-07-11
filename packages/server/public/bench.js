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
      options.push({ set: s.name, scene: name, label: `${s.name} / ${name}` });
    }
  }
  return options;
}

async function load(setName, sceneName) {
  if (rt) { rt.destroy(); rt = null; }
  scene = await (await fetch(`/examples/${setName}/scenes/${sceneName}.json`)).json();
  rt = riposte.createRuntime(scene, $('stage'), { assetBase: `/examples/${setName}/` });
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
  const options = await listScenes();
  const select = $('sceneSelect');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = `${o.set}/${o.scene}`;
    opt.textContent = o.label;
    select.append(opt);
  }

  const wantSet = params.get('set') ?? (options[0] && options[0].set);
  const wantScene = params.get('scene') ?? (options[0] && options[0].scene);
  if (!wantSet || !wantScene) return;
  select.value = `${wantSet}/${wantScene}`;
  await load(wantSet, wantScene);

  select.addEventListener('change', () => {
    const [s, sc] = select.value.split('/');
    void load(s, sc);
  });
  $('btnPlay').addEventListener('click', () => rt.play());
  $('btnNext').addEventListener('click', () => rt.next());
  $('btnStop').addEventListener('click', () => rt.stop());
  $('btnReset').addEventListener('click', () => {
    const [s, sc] = select.value.split('/');
    void load(s, sc);
  });
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
    window.__benchReady = true;
  }
}

void main();
