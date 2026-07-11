/**
 * Central editor state (Svelte 5 runes).
 *
 * Mutations go through mutate(): full-document snapshots feed the undo/redo
 * stack (scene docs are ~35 KB — snapshots are cheap and correct by
 * construction). `version` bumps trigger a Stage rebuild.
 */

import type { BezierEasing, ElementStyle, Layer, SceneDoc, StyleProperty } from '@riposte/shared';

export interface SetRef {
  root: string;
  name: string;
  scenes: string[];
  components: string[];
  fonts: { family: string; file: string }[];
}

export interface AssetInfo {
  file: string;
  size: number;
}

class EditorState {
  sets = $state<SetRef[]>([]);
  setRef = $state<SetRef | null>(null);
  /** All scene docs of the open set, by file — drives the usage scan. */
  allScenes = $state<Record<string, SceneDoc | null>>({});
  assets = $state<AssetInfo[]>([]);

  sceneFile = $state<string | null>(null);
  scene = $state<SceneDoc | null>(null);
  version = $state(0);
  dirty = $state(false);

  frame = $state(0);
  playing = $state(false);
  /** Script preview: stage runs the FULL runtime (actions + previewData). */
  scriptPreview = $state(false);
  selectedLayerId = $state<string | null>(null);
  /** Selected keyframe on the selected layer. targetKey: 'el' or 'mask<i>'. */
  selectedKf = $state<{ targetKey: string; prop: string; frame: number } | null>(null);

  status = $state('');

  private undoStack: { label: string; before: string; after: string }[] = [];
  private undoIndex = 0;

  get selectedLayer(): Layer | null {
    return this.scene?.composition.layers.find((l) => l.id === this.selectedLayerId) ?? null;
  }

  selectLayer(id: string | null): void {
    if (this.selectedLayerId !== id) this.selectedKf = null;
    this.selectedLayerId = id;
  }

  get assetBase(): string {
    return this.setRef ? `/${this.setRef.root}/${this.setRef.name}/` : '';
  }

  /** file → scene names using it (images, sequences, loaders don't count — they're runtime data). */
  get assetUsage(): Map<string, string[]> {
    const usage = new Map<string, string[]>();
    const add = (file: string, scene: string) => {
      const list = usage.get(file) ?? [];
      if (!list.includes(scene)) list.push(scene);
      usage.set(file, list);
    };
    for (const [file, doc] of Object.entries(this.allScenes)) {
      if (!doc) continue;
      const sceneName = file.replace(/^scenes\//, '').replace(/\.json$/, '');
      for (const layer of doc.composition.layers) {
        const els = [layer.element, ...(layer.masks ?? [])];
        for (const el of els) {
          if (el.type === 'image' && el.asset) add(el.asset, sceneName);
          if (el.type === 'imageSequence') for (const f of el.frames) add(f, sceneName);
        }
      }
    }
    for (const font of this.setRef?.fonts ?? []) add(font.file, '(fonts)');
    return usage;
  }

  get unusedAssets(): AssetInfo[] {
    const usage = this.assetUsage;
    return this.assets.filter((a) => !usage.has(a.file));
  }

  async loadSets(): Promise<void> {
    this.sets = await (await fetch('/api/sets')).json();
  }

  async openSet(ref: SetRef): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.setRef = ref;
    this.scene = null;
    this.sceneFile = null;
    this.selectedLayerId = null;
    const q = `root=${encodeURIComponent(ref.root)}&name=${encodeURIComponent(ref.name)}`;
    const bundle = await (await fetch(`/api/set?${q}`)).json();
    this.allScenes = bundle.scenes;
    this.assets = await (await fetch(`/api/assets?${q}`)).json();
    const first = ref.scenes[0];
    if (first) this.openScene(first);
  }

  openScene(file: string): void {
    if (this.dirty && this.sceneFile) {
      // keep edits in the bundle so switching back doesn't lose them
      this.allScenes[this.sceneFile] = this.scene;
    }
    this.sceneFile = file;
    const doc = this.allScenes[file];
    this.scene = doc ? (JSON.parse(JSON.stringify(doc)) as SceneDoc) : null;
    this.frame = this.firstPauseFrame();
    this.playing = false;
    this.selectedLayerId = null;
    this.selectedKf = null;
    this.dirty = false;
    this.undoStack = [];
    this.undoIndex = 0;
    this.version++;
  }

  firstPauseFrame(): number {
    const m = this.scene?.composition.markers.find((m) => m.type === 'pause');
    return m ? m.frame : 0;
  }

  /** Run a mutation on the scene doc; records undo state and rebuilds. */
  mutate(label: string, fn: (scene: SceneDoc) => void): void {
    if (!this.scene) return;
    const before = JSON.stringify(this.scene);
    fn(this.scene);
    const after = JSON.stringify(this.scene);
    if (before === after) return;
    this.undoStack.length = this.undoIndex;
    this.undoStack.push({ label, before, after });
    this.undoIndex++;
    this.dirty = true;
    this.version++;
  }

  undo(): void {
    if (this.undoIndex === 0 || !this.scene) return;
    this.undoIndex--;
    this.scene = JSON.parse(this.undoStack[this.undoIndex]!.before) as SceneDoc;
    this.dirty = true;
    this.version++;
  }

  redo(): void {
    if (this.undoIndex >= this.undoStack.length || !this.scene) return;
    this.scene = JSON.parse(this.undoStack[this.undoIndex]!.after) as SceneDoc;
    this.undoIndex++;
    this.dirty = true;
    this.version++;
  }

  async save(): Promise<void> {
    if (!this.scene || !this.sceneFile || !this.setRef) return;
    await fetch('/api/scene', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        root: this.setRef.root,
        name: this.setRef.name,
        file: this.sceneFile,
        doc: this.scene,
      }),
    });
    this.allScenes[this.sceneFile] = JSON.parse(JSON.stringify(this.scene)) as SceneDoc;
    this.dirty = false;
    this.flash(`saved ${this.sceneFile}`);
  }

  /** Delete a scene: out of the set AND off the disk (after confirmation). */
  async removeScene(file: string): Promise<void> {
    if (!this.setRef) return;
    const name = file.replace(/^scenes\//, '').replace(/\.json$/, '');
    if (!confirm(`Delete scene "${name}"?\nThe file is deleted from disk; assets used only by it become "unused".`)) return;
    await fetch('/api/scene/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: this.setRef.root, name: this.setRef.name, file, deleteFile: true }),
    });
    this.setRef.scenes = this.setRef.scenes.filter((s) => s !== file);
    delete this.allScenes[file];
    this.allScenes = { ...this.allScenes };
    if (this.sceneFile === file) {
      this.scene = null;
      this.sceneFile = null;
      this.selectedLayerId = null;
      this.dirty = false;
      this.version++;
    }
    this.flash(`deleted ${name}`);
  }

  /** Register a fresh scene doc on the server and open it. */
  private async createScene(name: string, doc: SceneDoc): Promise<void> {
    const file = `scenes/${name}.json`;
    const r = await this.post('/api/scene/create', { file, doc });
    if (!r || !this.setRef) return;
    this.setRef.scenes = [...this.setRef.scenes, file];
    this.allScenes = { ...this.allScenes, [file]: doc };
    this.openScene(file);
    this.flash(`created ${name}`);
  }

  /** New empty scene — canvas size/fps borrowed from the set's other scenes. */
  async newScene(): Promise<void> {
    if (!this.setRef) return;
    const name = prompt('Name for the new scene:', '')?.trim();
    if (!name) return;
    if (!/^[\w .()-]+$/.test(name)) {
      this.flash('invalid scene name');
      return;
    }
    const donor = Object.values(this.allScenes).find((d) => d)?.composition;
    await this.createScene(name, {
      formatVersion: 1,
      name,
      composition: {
        width: donor?.width ?? 1920,
        height: donor?.height ?? 1080,
        fps: donor?.fps ?? 50,
        duration: 100,
        markers: [{ frame: 50, type: 'pause' }],
        layers: [],
      },
    });
  }

  async duplicateScene(file: string): Promise<void> {
    const src = this.sceneFile === file && this.scene ? this.scene : this.allScenes[file];
    if (!src) return;
    const base = file.replace(/^scenes\//, '').replace(/\.json$/, '');
    const name = prompt('Name for the copy:', `${base}_copy`)?.trim();
    if (!name || name === base) return;
    if (!/^[\w .()-]+$/.test(name)) {
      this.flash('invalid scene name');
      return;
    }
    const doc = JSON.parse(JSON.stringify(src)) as SceneDoc;
    doc.name = name;
    await this.createScene(name, doc);
  }

  /** Create an image-sequence layer from a dragged sequence group: the
   * layer's span is exactly one timeline frame per image. */
  addSequenceLayer(files: string[]): void {
    const scene = this.scene;
    if (!scene || files.length === 0) return;
    const comp = scene.composition;
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || 200;
      const h = img.naturalHeight || 200;
      const id = `layer-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      this.mutate('add image sequence', (s) => {
        s.composition.layers.push({
          id,
          startFrame: 0,
          duration: files.length,
          element: {
            id: `${id}-el`,
            type: 'imageSequence',
            frames: [...files],
            style: {
              x: { value: Math.round(comp.width / 2) },
              y: { value: Math.round(comp.height / 2) },
              width: { value: w },
              height: { value: h },
            },
          },
        });
      });
      this.selectLayer(id);
      this.flash(`added sequence (${files.length} frames)`);
    };
    img.onerror = () => this.flash(`could not load ${files[0]}`);
    img.src = this.assetBase + files[0];
  }

  /** Create a fresh element layer (toolbar "+ text" etc.) — topmost, full span. */
  addElementLayer(type: 'text' | 'rectangle' | 'ellipse' | 'imageLoader'): void {
    const comp = this.scene?.composition;
    if (!comp) return;
    const id = `layer-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const cx = Math.round(comp.width / 2);
    const cy = Math.round(comp.height / 2);
    const style = (w: number, h: number) => ({
      x: { value: cx },
      y: { value: cy },
      width: { value: w },
      height: { value: h },
    });
    const element =
      type === 'text'
        ? {
            id: `${id}-el`,
            type,
            content: 'Text',
            fontFamily: this.setRef?.fonts[0]?.family,
            textAlign: 'center' as const,
            style: { ...style(400, 60), fontSize: { value: 40 }, color: { value: '#ffffff', unit: 'color' as const } },
          }
        : type === 'rectangle'
          ? { id: `${id}-el`, type, fill: '#3a6ea5', style: style(300, 100) }
          : type === 'ellipse'
            ? { id: `${id}-el`, type, fill: '#3a6ea5', style: style(200, 200) }
            : { id: `${id}-el`, type, fit: 'contain' as const, style: style(400, 300) };
    this.mutate(`add ${type}`, (s) => {
      s.composition.layers.push({ id, startFrame: 0, duration: s.composition.duration, element });
    });
    this.selectLayer(id);
  }

  /** POST an api call with the set ref mixed in; flashes errors, null on failure. */
  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (!this.setRef) return null;
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: this.setRef.root, name: this.setRef.name, ...body }),
    });
    const r = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      this.flash(`FAILED: ${r['error'] ?? res.status}`);
      return null;
    }
    return r;
  }

  /** Re-fetch set.json + all docs + assets after server-side rewrites. Keeps the open scene/selection. */
  private async reloadBundle(): Promise<void> {
    const ref = this.setRef;
    if (!ref) return;
    const q = `root=${encodeURIComponent(ref.root)}&name=${encodeURIComponent(ref.name)}`;
    const bundle = await (await fetch(`/api/set?${q}`)).json();
    this.allScenes = bundle.scenes;
    this.assets = await (await fetch(`/api/assets?${q}`)).json();
    ref.scenes = bundle.set.scenes ?? [];
    ref.components = bundle.set.components ?? [];
    ref.fonts = bundle.set.fonts ?? [];
    if (this.sceneFile) {
      const doc = this.allScenes[this.sceneFile];
      this.scene = doc ? (JSON.parse(JSON.stringify(doc)) as SceneDoc) : null;
      // disk is the new truth — old snapshots would resurrect renamed refs
      this.undoStack = [];
      this.undoIndex = 0;
      this.dirty = false;
      this.version++;
    }
  }

  /** Rename a scene or component (file + set.json + component refs, server-side). */
  async renameScene(file: string, newName: string): Promise<void> {
    newName = newName.trim();
    const oldName = file.replace(/^scenes\//, '').replace(/\.json$/, '');
    if (!newName || newName === oldName) return;
    if (this.dirty) {
      this.flash('save your changes before renaming');
      return;
    }
    const r = await this.post('/api/scene/rename', { file, newName });
    if (!r) return;
    if (this.sceneFile === file) this.sceneFile = r['file'] as string;
    await this.reloadBundle();
    this.flash(`renamed to ${newName}`);
  }

  /** Rename an asset file; the server rewrites every reference across the set. */
  async renameAsset(from: string, to: string): Promise<void> {
    to = to.trim();
    if (!to || to === from) return;
    if (this.dirty) {
      this.flash('save your changes before renaming assets');
      return;
    }
    const r = await this.post('/api/assets/rename', { from, to });
    if (!r) return;
    await this.reloadBundle();
    const changed = (r['changed'] as string[]).length;
    this.flash(`renamed asset${changed ? ` — ${changed} file(s) updated` : ''}`);
  }

  /** Timeline eye toggle — same flag as the inspector's Hidden checkbox. */
  setLayerHidden(id: string, hidden: boolean): void {
    this.mutate(hidden ? 'hide layer' : 'show layer', (scene) => {
      const l = scene.composition.layers.find((x) => x.id === id);
      if (l) l.hidden = hidden || undefined;
    });
  }

  /**
   * One name per layer: for BOUND elements the key is the name, so renaming
   * edits the key (a deliberate data-contract change); unbound layers keep a
   * plain display name.
   */
  renameLayer(id: string, value: string): void {
    value = value.trim();
    if (!value) return;
    const layer = this.scene?.composition.layers.find((l) => l.id === id);
    if (!layer) return;
    if (layer.element.key) this.setElementKey(id, value);
    else {
      this.mutate('rename layer', (scene) => {
        const l = scene.composition.layers.find((x) => x.id === id);
        if (l) l.name = value;
      });
    }
  }

  /** First unused variant of a key: _lamp → _lamp2 → _lamp3 … */
  private freeKey(base: string): string {
    const keys = new Set(this.scene?.composition.layers.map((l) => l.element.key).filter(Boolean));
    if (!keys.has(base)) return base;
    const m = /^(.*?)(\d+)$/.exec(base);
    const stem = m ? m[1]! : base;
    let n = m ? Number(m[2]) + 1 : 2;
    while (keys.has(`${stem}${n}`)) n++;
    return `${stem}${n}`;
  }

  /** Duplicate a layer directly above the original; a bound copy gets the
   * next free key so the two never fight over updates. */
  duplicateLayer(id: string): void {
    const scene = this.scene;
    if (!scene) return;
    const idx = scene.composition.layers.findIndex((l) => l.id === id);
    if (idx < 0) return;
    const copy = JSON.parse(JSON.stringify(scene.composition.layers[idx])) as Layer;
    const nid = `layer-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    copy.id = nid;
    copy.element.id = `${nid}-el`;
    copy.masks?.forEach((m, i) => (m.id = `${nid}-mask${i}`));
    let note = '';
    if (copy.element.key) {
      copy.element.key = this.freeKey(copy.element.key);
      note = ` as ${copy.element.key}`;
    }
    this.mutate('duplicate layer', (s) => {
      s.composition.layers.splice(idx + 1, 0, copy);
    });
    this.selectLayer(nid);
    this.flash(`duplicated${note}`);
  }

  deleteLayer(id: string): void {
    const layer = this.scene?.composition.layers.find((l) => l.id === id);
    if (!layer) return;
    const label = layer.element.key ?? layer.name ?? layer.element.type;
    this.mutate('delete layer', (s) => {
      const i = s.composition.layers.findIndex((l) => l.id === id);
      if (i >= 0) s.composition.layers.splice(i, 1);
    });
    if (this.selectedLayerId === id) this.selectLayer(null);
    this.flash(`deleted ${label} (Ctrl+Z restores)`);
  }

  /** Change an element's update key — refuses duplicates, announces the change. */
  setElementKey(id: string, key: string): void {
    key = key.trim();
    const layer = this.scene?.composition.layers.find((l) => l.id === id);
    if (!layer || key === (layer.element.key ?? '')) return;
    if (key && this.scene!.composition.layers.some((l) => l.id !== id && l.element.key === key)) {
      this.flash(`key ${key} is already used by another element`);
      return;
    }
    const old = layer.element.key;
    this.mutate('change key', (scene) => {
      const l = scene.composition.layers.find((x) => x.id === id);
      if (!l) return;
      if (key) l.element.key = key;
      else delete l.element.key;
    });
    if (old && key) this.flash(`key changed: ${old} → ${key}`);
    else if (!key) this.flash(`key ${old} removed — element is no longer data-bound`);
  }

  /** Move/trim a layer's visible span (timeline bar drag). */
  setLayerSpan(id: string, startFrame: number, duration: number): void {
    this.mutate('layer span', (scene) => {
      const l = scene.composition.layers.find((x) => x.id === id);
      if (!l) return;
      l.startFrame = startFrame;
      l.duration = duration;
    });
  }

  /** Create an image layer from an asset (drag & drop) — topmost, full span. */
  addImageLayer(assetFile: string): void {
    const scene = this.scene;
    if (!scene) return;
    const comp = scene.composition;
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || 200;
      const h = img.naturalHeight || 200;
      const id = `layer-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      this.mutate('add image layer', (s) => {
        s.composition.layers.push({
          id,
          startFrame: 0,
          duration: s.composition.duration,
          element: {
            id: `${id}-el`,
            type: 'image',
            asset: assetFile,
            style: {
              x: { value: Math.round(comp.width / 2) },
              y: { value: Math.round(comp.height / 2) },
              width: { value: w },
              height: { value: h },
            },
          },
        });
      });
      this.selectLayer(id);
      this.flash(`added ${assetFile.replace(/^assets\//, '')}`);
    };
    img.onerror = () => this.flash(`could not load ${assetFile}`);
    img.src = this.assetBase + assetFile;
  }

  async deleteUnusedAssets(): Promise<void> {
    if (!this.setRef) return;
    const unused = this.unusedAssets;
    if (unused.length === 0) return;
    const mb = (unused.reduce((s, a) => s + a.size, 0) / 1024 / 1024).toFixed(1);
    const preview = unused.slice(0, 12).map((a) => a.file).join('\n');
    const more = unused.length > 12 ? `\n… and ${unused.length - 12} more` : '';
    if (!confirm(`Delete ${unused.length} unused assets (${mb} MB)?\n\n${preview}${more}`)) return;
    const q = { root: this.setRef.root, name: this.setRef.name, files: unused.map((a) => a.file) };
    const r = await (await fetch('/api/assets/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(q),
    })).json();
    this.assets = this.assets.filter((a) => !r.deleted.includes(a.file));
    this.flash(`deleted ${r.deleted.length} unused assets (${mb} MB)`);
  }

  // ---- keyframe editing ------------------------------------------------------

  /** Resolve the style object a targetKey refers to on a layer of the LIVE doc. */
  static styleOf(layer: Layer, targetKey: string): ElementStyle | null {
    if (targetKey === 'el') return layer.element.style;
    const m = /^mask(\d+)$/.exec(targetKey);
    if (m) return layer.masks?.[Number(m[1])]?.style ?? null;
    return null;
  }

  private withStyle(label: string, targetKey: string, fn: (style: ElementStyle) => void): void {
    const id = this.selectedLayerId;
    if (!id) return;
    this.mutate(label, (scene) => {
      const layer = scene.composition.layers.find((l) => l.id === id);
      const style = layer ? EditorState.styleOf(layer, targetKey) : null;
      if (style) fn(style);
    });
  }

  /** Add a keyframe at the playhead (or remove it if one sits exactly there). */
  toggleKeyframe(targetKey: string, prop: string): void {
    const f = this.frame;
    this.withStyle(`keyframe ${prop}`, targetKey, (style) => {
      const p = (style[prop] ??= { value: 0 });
      const kfs = (p.keyframes ??= []);
      const existing = kfs.findIndex((k) => k.frame === f);
      if (existing >= 0) {
        kfs.splice(existing, 1);
        if (kfs.length === 0) delete p.keyframes;
      } else {
        kfs.push({ frame: f, value: propNumber(p, f, typeof p.value === 'number' ? p.value : 0) });
        kfs.sort((a, b) => a.frame - b.frame);
      }
    });
    if (this.selectedKf?.targetKey === targetKey && this.selectedKf.prop === prop && this.selectedKf.frame === f) {
      this.selectedKf = null;
    }
  }

  /** Set the value at the playhead: upsert a keyframe when animated, else the static value. */
  setValueAtPlayhead(targetKey: string, prop: string, value: number): void {
    const f = this.frame;
    this.withStyle(`set ${prop}`, targetKey, (style) => {
      const p = (style[prop] ??= { value });
      if (!p.keyframes || p.keyframes.length === 0) {
        p.value = value;
        return;
      }
      const existing = p.keyframes.find((k) => k.frame === f);
      if (existing) existing.value = value;
      else {
        p.keyframes.push({ frame: f, value });
        p.keyframes.sort((a, b) => a.frame - b.frame);
      }
    });
  }

  moveKeyframe(targetKey: string, prop: string, from: number, to: number): void {
    if (from === to) return;
    this.withStyle(`move keyframe`, targetKey, (style) => {
      const kfs = style[prop]?.keyframes;
      if (!kfs) return;
      const kf = kfs.find((k) => k.frame === from);
      if (!kf) return;
      const clash = kfs.findIndex((k) => k.frame === to);
      if (clash >= 0) kfs.splice(clash, 1);
      kf.frame = to;
      kfs.sort((a, b) => a.frame - b.frame);
    });
    if (this.selectedKf?.prop === prop && this.selectedKf.frame === from) {
      this.selectedKf = { targetKey, prop, frame: to };
    }
  }

  deleteSelectedKeyframe(): void {
    const sel = this.selectedKf;
    if (!sel) return;
    this.withStyle('delete keyframe', sel.targetKey, (style) => {
      const p = style[sel.prop];
      const kfs = p?.keyframes;
      if (!p || !kfs) return;
      const i = kfs.findIndex((k) => k.frame === sel.frame);
      if (i >= 0) kfs.splice(i, 1);
      if (kfs.length === 0) delete p.keyframes;
    });
    this.selectedKf = null;
  }

  setKeyframeEasing(easing: BezierEasing | null): void {
    const sel = this.selectedKf;
    if (!sel) return;
    this.withStyle('set easing', sel.targetKey, (style) => {
      const kf = style[sel.prop]?.keyframes?.find((k) => k.frame === sel.frame);
      if (!kf) return;
      if (easing) kf.easing = easing;
      else delete kf.easing;
    });
  }

  setKeyframeNumber(field: 'frame' | 'value', v: number): void {
    const sel = this.selectedKf;
    if (!sel) return;
    if (field === 'frame') {
      this.moveKeyframe(sel.targetKey, sel.prop, sel.frame, Math.max(0, Math.round(v)));
    } else {
      this.withStyle('set keyframe value', sel.targetKey, (style) => {
        const kf = style[sel.prop]?.keyframes?.find((k) => k.frame === sel.frame);
        if (kf) kf.value = v;
      });
    }
  }

  // ---- scene-level editing ---------------------------------------------------

  setCompositionNumber(field: 'fps' | 'duration' | 'width' | 'height', v: number): void {
    if (!Number.isFinite(v) || v <= 0) return;
    this.mutate(`set ${field}`, (scene) => {
      scene.composition[field] = Math.round(v);
    });
  }

  /** Composition action: JS run once at template load (middleware, globals). */
  setCompositionAction(code: string): void {
    this.mutate('edit composition action', (scene) => {
      if (code.trim() === '') delete scene.composition.action;
      else scene.composition.action = code;
    });
  }

  addMarker(type: 'pause' | 'outro' | 'action'): void {
    const frame = this.frame;
    this.mutate(`add ${type} marker`, (scene) => {
      const markers = scene.composition.markers;
      if (type === 'action') markers.push({ frame, type, source: '' });
      else if (!markers.some((m) => m.frame === frame && m.type === type)) markers.push({ frame, type });
      markers.sort((a, b) => a.frame - b.frame);
    });
  }

  updateMarker(index: number, patch: { frame?: number; source?: string }): void {
    this.mutate('edit marker', (scene) => {
      const m = scene.composition.markers[index];
      if (!m) return;
      if (patch.frame !== undefined && Number.isFinite(patch.frame)) m.frame = Math.max(0, Math.round(patch.frame));
      if (patch.source !== undefined && m.type === 'action') m.source = patch.source;
      scene.composition.markers.sort((a, b) => a.frame - b.frame);
    });
  }

  removeMarker(index: number): void {
    this.mutate('remove marker', (scene) => {
      scene.composition.markers.splice(index, 1);
    });
  }

  async exportSet(): Promise<void> {
    if (!this.setRef) return;
    const remembered = localStorage.getItem('riposte.exportDir') ?? '';
    const outDir = prompt(
      'Export folder — paste the full path of your CasparCG template directory\n' +
        '(browsers cannot open a real folder picker for server paths; the last used path is remembered).\n' +
        'Leave empty for projects/_export/' + this.setRef.name + ':',
      remembered,
    );
    if (outDir === null) return;
    this.flash('exporting…');
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: this.setRef.root, name: this.setRef.name, outDir }),
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error ?? `server responded ${res.status}`);
      if (outDir.trim()) localStorage.setItem('riposte.exportDir', outDir.trim());
      const mb = (r.assetBytes / 1048576).toFixed(1);
      this.flash(`exported ${r.scenes.length} templates + ${r.assetsCopied} assets (${mb} MB) → ${r.outDir}`);
      if (r.warnings?.length) console.warn('export warnings', r.warnings);
    } catch (err) {
      this.flash(`EXPORT FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async confirmDiscard(): Promise<boolean> {
    if (!this.dirty) return true;
    return confirm('Unsaved changes in the current scene — discard them?');
  }

  flash(msg: string): void {
    this.status = msg;
    setTimeout(() => {
      if (this.status === msg) this.status = '';
    }, 4000);
  }
}

export const ed = new EditorState();

/**
 * The one display name of a layer: the element's KEY when bound, the stored
 * name when a human wrote one, otherwise a label derived from the element.
 */
export function layerLabel(layer: Layer): string {
  const el = layer.element;
  if (el.key) return el.key;
  if (layer.name) return layer.name;
  switch (el.type) {
    case 'image':
      return 'image ' + el.asset.replace(/^assets\//, '');
    case 'imageSequence':
      return `sequence (${el.frames.length})`;
    case 'imageLoader':
      return 'image loader';
    case 'text': {
      const t = el.content.replace(/<[^>]*>/g, '').trim();
      return t ? `text “${t.slice(0, 24)}”` : 'text';
    }
    case 'composition':
      return 'comp ' + el.compositionId.replace(/^scenes\//, '').replace(/\.json$/, '');
    default:
      return el.type;
  }
}

// ---- shared geometry/property helpers used by Stage + Inspector -------------

export function propNumber(p: StyleProperty | undefined, frame: number, fallback: number): number {
  if (!p) return fallback;
  const kfs = p.keyframes;
  if (!kfs || kfs.length === 0) {
    return typeof p.value === 'number' ? p.value : fallback;
  }
  // linear scan mirroring runtime interpolation closely enough for editor UI
  let prev = kfs[0]!;
  if (frame <= prev.frame) return num(prev.value, fallback);
  for (let i = 1; i < kfs.length; i++) {
    const next = kfs[i]!;
    if (frame <= next.frame) {
      const t = (frame - prev.frame) / (next.frame - prev.frame || 1);
      const a = num(prev.value, fallback);
      const b = num(next.value, fallback);
      return a + (b - a) * t;
    }
    prev = next;
  }
  return num(kfs[kfs.length - 1]!.value, fallback);
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Shift a property (static value AND all keyframes) by a delta — move semantics. */
export function shiftProperty(p: StyleProperty | undefined, delta: number): void {
  if (!p || delta === 0) return;
  if (typeof p.value === 'number') p.value += delta;
  for (const k of p.keyframes ?? []) {
    if (typeof k.value === 'number') k.value += delta;
  }
}
