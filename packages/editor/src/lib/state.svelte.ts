/**
 * Central editor state (Svelte 5 runes).
 *
 * Mutations go through mutate(): full-document snapshots feed the undo/redo
 * stack (scene docs are ~35 KB — snapshots are cheap and correct by
 * construction). `version` bumps trigger a Stage rebuild.
 */

import { trimToContent, type BezierEasing, type ElementStyle, type Layer, type SceneDoc, type StyleProperty } from '@riposte/shared';

export interface SetRef {
  root: string;
  name: string;
  scenes: string[];
  components: string[];
  fonts: { family: string; file: string }[];
  export?: SetExportSettings;
}

export interface SetExportSettings {
  mode?: 'external' | 'baked';
  preloadAssets?: boolean;
  imageFormat?: 'png' | 'webp';
  webpQuality?: number | 'lossless';
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
  /**
   * Files whose in-memory doc differs from disk. Scene switches PARK unsaved
   * edits in the bundle (allScenes) — without this map they looked saved (the
   * single `dirty` flag was reset), never hit disk, and export/deploy shipped
   * the stale file. Saves clear the entry; export/deploy save these first.
   */
  dirtyFiles = $state<Record<string, boolean>>({});

  private markDirty(): void {
    this.dirty = true;
    if (this.sceneFile) this.dirtyFiles[this.sceneFile] = true;
  }

  frame = $state(0);
  playing = $state(false);
  /**
   * CasparCG lifecycle simulation (Stage runs the state machine): PLAY
   * builds up and parks at pause markers with loop layers cycling, NEXT
   * resumes (last pause = outro + loop fade), STOP jumps to the outro.
   * `req`/`reqType` carry commands to the Stage effect.
   */
  cg = $state<{ active: boolean; held: boolean; req: number; reqType: 'play' | 'next' | 'stop' }>({
    active: false,
    held: false,
    req: 0,
    reqType: 'play',
  });

  cgPlay(): void {
    this.playing = false;
    this.cg = { active: true, held: false, req: this.cg.req + 1, reqType: 'play' };
  }

  cgNext(): void {
    if (this.cg.active) this.cg = { ...this.cg, req: this.cg.req + 1, reqType: 'next' };
  }

  cgStop(): void {
    if (this.cg.active) this.cg = { ...this.cg, req: this.cg.req + 1, reqType: 'stop' };
  }

  cgOff(): void {
    if (this.cg.active) this.cg = { ...this.cg, active: false, held: false };
  }
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

  /**
   * file → usage sites ("scene › element"). Counts image assets, sequence
   * frames, imageLoader PLACEHOLDERS and fonts; loader runtime data doesn't
   * count (those images arrive via update()).
   */
  get assetUsage(): Map<string, string[]> {
    const usage = new Map<string, string[]>();
    const add = (file: string, site: string) => {
      const list = usage.get(file) ?? [];
      if (!list.includes(site)) list.push(site);
      usage.set(file, list);
    };
    for (const [file, doc] of Object.entries(this.allScenes)) {
      if (!doc) continue;
      const sceneName = file.replace(/^scenes\//, '').replace(/\.json$/, '');
      for (const layer of doc.composition.layers) {
        const label = layer.element.key ?? layer.name ?? layer.element.type;
        const els = [layer.element, ...(layer.masks ?? [])];
        for (const el of els) {
          if (el.type === 'image' && el.asset) add(el.asset, `${sceneName} › ${label}`);
          if (el.type === 'imageSequence') for (const f of el.frames) add(f, `${sceneName} › ${label}`);
          if (el.type === 'imageLoader' && el.placeholder) {
            add(el.placeholder, `${sceneName} › ${label} (placeholder)`);
          }
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

  /** Set-options dialog (sidebar set click opens it instead of a scene). */
  setOptionsOpen = $state(false);

  async openSet(ref: SetRef, opts: { showOptions?: boolean } = {}): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.setRef = ref;
    this.scene = null;
    this.sceneFile = null;
    this.selectedLayerId = null;
    const q = `root=${encodeURIComponent(ref.root)}&name=${encodeURIComponent(ref.name)}`;
    const bundle = await (await fetch(`/api/set?${q}`)).json();
    this.allScenes = bundle.scenes;
    this.dirtyFiles = {}; // discard was confirmed above
    this.dirty = false;
    this.assets = await (await fetch(`/api/assets?${q}`)).json();
    if (opts.showOptions) {
      this.setOptionsOpen = true;
      return; // the user picks a scene from the list when they're done here
    }
    const first = ref.scenes[0];
    if (first) this.openScene(first);
  }

  /** Persist export settings into the set's set.json. */
  async saveSetSettings(patch: SetExportSettings): Promise<void> {
    if (!this.setRef) return;
    const r = await this.post('/api/set/settings', { export: patch });
    if (!r) return;
    this.setRef.export = r['export'] as SetExportSettings;
    const inList = this.sets.find((s) => s.root === this.setRef!.root && s.name === this.setRef!.name);
    if (inList) inList.export = this.setRef.export;
    this.flash('set options saved');
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
    this.cg = { ...this.cg, active: false, held: false };
    this.selectedLayerId = null;
    this.selectedKf = null;
    // switching back to a scene with parked edits keeps it saveable
    this.dirty = !!this.dirtyFiles[file];
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
    this.markDirty();
    this.version++;
  }

  undo(): void {
    if (this.undoIndex === 0 || !this.scene) return;
    this.undoIndex--;
    this.scene = JSON.parse(this.undoStack[this.undoIndex]!.before) as SceneDoc;
    this.markDirty();
    this.version++;
  }

  redo(): void {
    if (this.undoIndex >= this.undoStack.length || !this.scene) return;
    this.scene = JSON.parse(this.undoStack[this.undoIndex]!.after) as SceneDoc;
    this.undoIndex++;
    this.markDirty();
    this.version++;
  }

  async save(): Promise<void> {
    if (!this.scene || !this.sceneFile || !this.setRef) return;
    this.ownSave = { file: this.sceneFile, at: Date.now() };
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
    this.dirtyFiles[this.sceneFile] = false;
    this.flash(`saved ${this.sceneFile}`);
  }

  // ---- server push (SSE): external writers (MCP) show up live ---------------

  private ownSave: { file: string; at: number } | null = null;
  private es: EventSource | null = null;

  connectEvents(): void {
    if (this.es) return; // once — survives HMR re-mounts
    const es = new EventSource('/api/events');
    this.es = es;
    // custom event is 'open-scene', NOT 'open' — the native EventSource
    // connect event is also named 'open' and carries no data.
    es.addEventListener('open-scene', (e) => {
      const data = (e as MessageEvent).data;
      if (typeof data !== 'string') return;
      void this.onRemoteOpen(JSON.parse(data));
    });
    es.addEventListener('scene-saved', (e) => {
      const data = (e as MessageEvent).data;
      if (typeof data !== 'string') return;
      void this.onRemoteSaved(JSON.parse(data));
    });
  }

  private async onRemoteOpen(p: { root: string; name: string; file?: string; frame?: number }): Promise<void> {
    if (this.setRef?.root !== p.root || this.setRef?.name !== p.name) {
      if (this.sets.length === 0) await this.loadSets();
      const ref = this.sets.find((s) => s.root === p.root && s.name === p.name);
      if (!ref) return;
      await this.openSet(ref); // confirmDiscard() protects unsaved edits
      if (this.setRef !== ref) return; // user declined the discard
    }
    if (p.file && this.sceneFile !== p.file && this.allScenes[p.file] !== undefined) {
      this.openScene(p.file);
    }
    if (p.frame !== undefined && this.scene) {
      this.playing = false;
      this.frame = Math.min(Math.max(Math.round(p.frame), 0), this.scene.composition.duration - 1);
    }
    this.flash(
      `remote: opened ${p.name}${p.file ? ' / ' + sceneNameOf(p.file) : ''}${p.frame !== undefined ? ` @ frame ${p.frame}` : ''}`,
    );
  }

  private async onRemoteSaved(p: { root: string; name: string; file: string }): Promise<void> {
    // our own save echoes back through the broadcast — ignore it
    if (this.ownSave && this.ownSave.file === p.file && Date.now() - this.ownSave.at < 2000) return;
    if (this.setRef?.root !== p.root || this.setRef?.name !== p.name) return;
    const q = `root=${encodeURIComponent(p.root)}&name=${encodeURIComponent(p.name)}`;
    const bundle = (await (await fetch(`/api/set?${q}`)).json()) as { scenes: Record<string, SceneDoc | null> };

    // Docs with unsaved edits (parked by scene switches) must survive the
    // bundle refresh — the disk copies in the bundle are older than them.
    const parked: Record<string, SceneDoc | null> = {};
    if (this.dirty && this.sceneFile) this.allScenes[this.sceneFile] = this.scene;
    for (const [f, d] of Object.entries(this.dirtyFiles)) {
      if (d && f !== p.file && this.allScenes[f]) parked[f] = this.allScenes[f];
    }

    if (p.file === this.sceneFile) {
      if (this.dirty) {
        // don't clobber in-flight edits; the bundle copy is refreshed on next open
        this.flash(`${sceneNameOf(p.file)} was changed externally — you have unsaved edits`);
        return;
      }
      this.allScenes = { ...bundle.scenes, ...parked };
      const doc = bundle.scenes[p.file];
      this.scene = doc ? (JSON.parse(JSON.stringify(doc)) as SceneDoc) : null;
      if (this.selectedLayerId && !this.scene?.composition.layers.some((l) => l.id === this.selectedLayerId)) {
        this.selectedLayerId = null;
      }
      this.selectedKf = null;
      this.undoStack = [];
      this.undoIndex = 0;
      this.version++;
      this.flash(`remote: ${sceneNameOf(p.file)} updated`);
    } else {
      // another scene (possibly a component rendered in this one) changed —
      // take the fresh bundle but keep every doc that has unsaved edits
      this.allScenes = { ...bundle.scenes, ...parked };
      this.version++;
    }
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
    this.dirtyFiles[file] = false;
    if (this.sceneFile === file) {
      this.scene = null;
      this.sceneFile = null;
      this.selectedLayerId = null;
      this.dirty = false;
      this.version++;
    }
    this.flash(`deleted ${name}`);
  }

  /** Create an empty set (folder + set.json + assets/) and open it. */
  async createSet(presetName?: string): Promise<SetRef | null> {
    const name = (presetName ?? prompt('Name for the new set:', ''))?.trim();
    if (!name) return null;
    const res = await fetch('/api/set/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const r = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      this.flash(`FAILED: ${r['error'] ?? res.status}`);
      return null;
    }
    await this.loadSets();
    const ref = this.sets.find((s) => s.root === 'projects' && s.name === name) ?? null;
    if (ref) await this.openSet(ref);
    this.flash(`created set ${name}`);
    return ref;
  }

  /** Upload .loo files into an existing or new set; the server-side importer
   * does the real work (shared asset pool, script migration). */
  async importLooFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    const def = this.setRef?.root === 'projects' ? this.setRef.name : files[0]!.name.replace(/\.loo$/i, '');
    const name = prompt('Import into set (existing name adds to it, new name creates it):', def)?.trim();
    if (!name) return;
    if (!this.sets.some((s) => s.root === 'projects' && s.name === name)) {
      if (!(await this.createSet(name))) return;
    }
    const q = `root=projects&name=${encodeURIComponent(name)}`;
    let count = 0;
    const allScenes: string[] = [];
    for (const f of files) {
      count++;
      this.status = `importing ${f.name} (${count}/${files.length})…`;
      const res = await fetch(`/api/set/import-loo?${q}&filename=${encodeURIComponent(f.name)}`, {
        method: 'POST',
        body: f,
      });
      const r = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        this.flash(`IMPORT FAILED ${f.name}: ${r['error'] ?? res.status}`);
        return;
      }
      allScenes.push(...((r['scenes'] as string[]) ?? []));
      for (const w of (r['warnings'] as string[]) ?? []) console.warn(`${f.name}: ${w}`);
    }
    await this.loadSets();
    const ref = this.sets.find((s) => s.root === 'projects' && s.name === name);
    if (ref) await this.openSet(ref);
    this.flash(`imported ${allScenes.length} scene(s) from ${files.length} .loo file(s) into ${name}`);
  }

  /** Upload asset files into the open set; fonts are auto-registered. */
  async uploadAssets(files: File[]): Promise<void> {
    const ref = this.setRef;
    if (!ref || files.length === 0) return;
    const q = `root=${encodeURIComponent(ref.root)}&name=${encodeURIComponent(ref.name)}`;
    const notes: string[] = [];
    let count = 0;
    for (const f of files) {
      count++;
      this.status = `uploading ${f.name} (${count}/${files.length})…`;
      const res = await fetch(`/api/assets/upload?${q}&filename=${encodeURIComponent(f.name)}`, {
        method: 'POST',
        body: f,
      });
      const r = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        this.flash(`UPLOAD FAILED ${f.name}: ${r['error'] ?? res.status}`);
        return;
      }
      if (r['status'] !== 'written') notes.push(`${f.name}: ${r['status']}`);
    }
    // refresh assets + fonts without touching the (possibly dirty) open scene
    this.assets = await (await fetch(`/api/assets?${q}`)).json();
    const sets = (await (await fetch('/api/sets')).json()) as SetRef[];
    const fresh = sets.find((s) => s.root === ref.root && s.name === ref.name);
    if (fresh) ref.fonts = fresh.fonts;
    this.flash(`uploaded ${files.length} file(s)${notes.length ? ` — ${notes.join('; ')}` : ''}`);
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
  addSequenceLayer(files: string[], at?: { x: number; y: number }): void {
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
              x: { value: Math.round(at?.x ?? comp.width / 2) },
              y: { value: Math.round(at?.y ?? comp.height / 2) },
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

  /** Embed a component (nested composition) dropped from the sidebar. */
  addComponentLayer(file: string, at?: { x: number; y: number }): void {
    const scene = this.scene;
    if (!scene) return;
    if (this.sceneFile === file) {
      this.flash('cannot embed a component into itself');
      return;
    }
    const child = this.allScenes[file]?.composition;
    if (!child) {
      this.flash(`component ${file} is not loaded`);
      return;
    }
    const comp = scene.composition;
    const id = `layer-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.mutate('add component', (s) => {
      s.composition.layers.push({
        id,
        startFrame: 0,
        duration: s.composition.duration,
        element: {
          id: `${id}-el`,
          type: 'composition',
          compositionId: file,
          style: {
            x: { value: Math.round(at?.x ?? comp.width / 2) },
            y: { value: Math.round(at?.y ?? comp.height / 2) },
            width: { value: child.width },
            height: { value: child.height },
          },
        },
      });
    });
    this.selectLayer(id);
    this.flash(`embedded ${sceneNameOf(file)}`);
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

  /**
   * Rename a whole image sequence: the server moves every frame to
   * assets/<newName>/<frame#>.<ext> and rewrites all references across the set.
   */
  async renameSequence(files: string[], newName: string): Promise<void> {
    newName = newName.trim();
    if (files.length === 0 || !newName) return;
    if (this.dirty) {
      this.flash('save your changes before renaming assets');
      return;
    }
    const r = await this.post('/api/assets/rename-sequence', { files, newName });
    if (!r) return;
    await this.reloadBundle();
    const changed = (r['changed'] as string[]).length;
    this.flash(`renamed sequence to ${newName}${changed ? ` — ${changed} file(s) updated` : ''}`);
  }

  /**
   * Add a rectangle mask fitted to the element's box (falls back to the full
   * frame when the element has no width/height, e.g. auto-sized text) — no
   * visible change until it's resized, rounded or animated.
   */
  addMask(layerId: string): void {
    let fitted = false;
    let count = 0;
    this.mutate('add mask', (scene) => {
      const l = scene.composition.layers.find((x) => x.id === layerId);
      if (!l) return;
      const c = scene.composition;
      const s = l.element.style;
      const w = Number(s.width?.value) || 0;
      const h = Number(s.height?.value) || 0;
      fitted = w > 0 && h > 0;
      const id = `mask-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      // reassign (not push) — most robust way to signal the masks change
      l.masks = [
        ...(l.masks ?? []),
        {
          id,
          type: 'rectangle',
          style: fitted
            ? {
                x: { value: Number(s.x?.value) || 0 },
                y: { value: Number(s.y?.value) || 0 },
                width: { value: w },
                height: { value: h },
              }
            : {
                x: { value: c.width / 2 },
                y: { value: c.height / 2 },
                width: { value: c.width },
                height: { value: c.height },
              },
        },
      ];
      count = l.masks.length;
    });
    if (count === 0) {
      this.flash('add mask FAILED — layer not found');
      return;
    }
    this.flash(`mask added (${count} on this layer${fitted ? ', fitted to the element' : ', full frame'})`);
  }

  deleteMask(layerId: string, index: number): void {
    // mask indices shift on delete — drop a possibly-stale keyframe selection
    if (this.selectedKf?.targetKey.startsWith('mask')) this.selectedKf = null;
    let count = -1;
    this.mutate('delete mask', (scene) => {
      const l = scene.composition.layers.find((x) => x.id === layerId);
      if (!l?.masks || index >= l.masks.length) return;
      const next = l.masks.filter((_, i) => i !== index);
      if (next.length === 0) delete l.masks;
      else l.masks = next;
      count = next.length;
    });
    this.flash(count < 0 ? 'delete mask FAILED — not found' : `mask deleted (${count} left on this layer)`);
  }

  /** Set an image loader's design-time placeholder (drag-drop or inspector). */
  setLoaderPlaceholder(layerId: string, file: string): void {
    this.mutate('set placeholder', (scene) => {
      const l = scene.composition.layers.find((x) => x.id === layerId);
      if (l && l.element.type === 'imageLoader') l.element.placeholder = file || undefined;
    });
    this.flash(file ? `placeholder → ${file.replace(/^assets\//, '')}` : 'placeholder cleared');
  }

  /** Timeline eye toggle — same flag as the inspector's Hidden checkbox. */
  setLayerHidden(id: string, hidden: boolean): void {
    this.mutate(hidden ? 'hide layer' : 'show layer', (scene) => {
      const l = scene.composition.layers.find((x) => x.id === id);
      if (l) l.hidden = hidden || undefined;
    });
  }

  /** Locked layers can't be selected or dragged on the stage. */
  setLayerLocked(id: string, locked: boolean): void {
    this.mutate(locked ? 'lock layer' : 'unlock layer', (scene) => {
      const l = scene.composition.layers.find((x) => x.id === id);
      if (l) l.locked = locked || undefined;
    });
    if (locked && this.selectedLayerId === id) this.selectLayer(null);
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
  addImageLayer(assetFile: string, at?: { x: number; y: number }): void {
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
              x: { value: Math.round(at?.x ?? comp.width / 2) },
              y: { value: Math.round(at?.y ?? comp.height / 2) },
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

  private withStyle(label: string, targetKey: string, fn: (style: ElementStyle) => void, layerId?: string): void {
    const id = layerId ?? this.selectedLayerId;
    if (!id) return;
    this.mutate(label, (scene) => {
      const layer = scene.composition.layers.find((l) => l.id === id);
      const style = layer ? EditorState.styleOf(layer, targetKey) : null;
      if (style) fn(style);
    });
  }

  /** Add a keyframe at the playhead (or remove it if one sits exactly there).
   * `fallback` seeds a property that doesn't exist yet (e.g. opacity → 1). */
  toggleKeyframe(targetKey: string, prop: string, fallback = 0, layerId?: string): void {
    const f = this.frame;
    this.withStyle(
      `keyframe ${prop}`,
      targetKey,
      (style) => {
        const p = (style[prop] ??= { value: fallback });
        const kfs = (p.keyframes ??= []);
        const existing = kfs.findIndex((k) => k.frame === f);
        if (existing >= 0) {
          kfs.splice(existing, 1);
          if (kfs.length === 0) delete p.keyframes;
        } else {
          kfs.push({ frame: f, value: propNumber(p, f, typeof p.value === 'number' ? p.value : fallback) });
          kfs.sort((a, b) => a.frame - b.frame);
        }
      },
      layerId,
    );
    if (this.selectedKf?.targetKey === targetKey && this.selectedKf.prop === prop && this.selectedKf.frame === f) {
      this.selectedKf = null;
    }
  }

  /** Set the value at the playhead: upsert a keyframe when animated, else the static value. */
  setValueAtPlayhead(targetKey: string, prop: string, value: number, layerId?: string): void {
    const f = this.frame;
    this.withStyle(
      `set ${prop}`,
      targetKey,
      (style) => {
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
      },
      layerId,
    );
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

  /** Shrink the duration to the content (markers/keyframes/sequences/loops). */
  trimDuration(): void {
    this.mutate('trim duration', (scene) => {
      trimToContent(scene.composition);
    });
    const last = (this.scene?.composition.duration ?? 1) - 1;
    if (this.frame > last) this.frame = last;
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

  /** Build CasparCG templates into the set's own export/ folder (incremental). */
  async exportSet(): Promise<void> {
    if (!this.setRef) return;
    const saved = await this.saveAll();
    if (saved) this.flash(`saved ${saved} scene(s) with unsaved edits`);
    this.flash('exporting…');
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: this.setRef.root, name: this.setRef.name }),
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error ?? `server responded ${res.status}`);
      const mb = (r.assetBytes / 1048576).toFixed(1);
      this.flash(
        `exported → ${r.outDir}: ${r.scenesUpdated.length}/${r.scenes.length} templates updated, ` +
          `${r.assetsCopied} assets copied (${r.assetsUpToDate} up to date, ${mb} MB total)`,
      );
      if (r.warnings?.length) console.warn('export warnings', r.warnings);
      this.reportContract(r.contract);
    } catch (err) {
      this.flash(`EXPORT FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Mapping-contract results from export/deploy: dead mappings (ControlCenter
   * sends a variable the template doesn't have) are the on-air-blank-field
   * class of bug — flash a warning and put the details in the devtools console.
   */
  private reportContract(reports: unknown): void {
    if (!Array.isArray(reports) || reports.length === 0) return;
    let dead = 0;
    for (const rep of reports as { configName: string; deadCount: number; scenes: unknown[] }[]) {
      dead += rep.deadCount;
      console.group(`mapping contract vs "${rep.configName}" (${rep.deadCount} dead mappings)`);
      for (const s of rep.scenes as { ccScene: string; templateName: string; deadMappings: string[]; unfilledKeys: string[] }[]) {
        if (s.deadMappings.length) console.warn(`${s.ccScene} → ${s.templateName}: DEAD ${s.deadMappings.join(', ')}`);
        if (s.unfilledKeys.length) console.info(`${s.ccScene} → ${s.templateName}: unfilled ${s.unfilledKeys.join(', ')}`);
      }
      console.groupEnd();
    }
    if (dead > 0) this.flash(`⚠ contract: ${dead} dead mapping(s) across ${reports.length} config(s) — details in devtools console`);
  }

  /** The Deploy button opens the dialog (target dir + force option). */
  deployDialogOpen = $state(false);

  deploySet(): void {
    if (!this.setRef) return;
    this.deployDialogOpen = true;
  }

  /** Export, then incrementally sync the export into the CasparCG template dir. */
  async deployTo(targetDir: string, force: boolean): Promise<void> {
    if (!this.setRef || !targetDir.trim()) return;
    const saved = await this.saveAll();
    if (saved) this.flash(`saved ${saved} scene(s) with unsaved edits`);
    this.flash(force ? 'deploying (full redeploy)…' : 'deploying…');
    try {
      const res = await fetch('/api/deploy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: this.setRef.root, name: this.setRef.name, targetDir, force }),
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error ?? `server responded ${res.status}`);
      localStorage.setItem('riposte.deployDir', targetDir.trim());
      const mb = (r.synced.copiedBytes / 1048576).toFixed(1);
      this.flash(
        `deployed → ${r.targetDir}: ${r.synced.copied} files copied (${mb} MB), ` +
          `${r.synced.upToDate} already up to date`,
      );
      if (r.exported.warnings?.length) console.warn('export warnings', r.exported.warnings);
      this.reportContract(r.contract);
    } catch (err) {
      this.flash(`DEPLOY FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async confirmDiscard(): Promise<boolean> {
    const parked = Object.entries(this.dirtyFiles)
      .filter(([, d]) => d)
      .map(([f]) => sceneNameOf(f));
    if (!this.dirty && parked.length === 0) return true;
    const what = parked.length ? parked.join(', ') : 'the current scene';
    return confirm(`Unsaved changes in ${what} — discard them?`);
  }

  /**
   * Save every scene with unsaved edits — including edits parked in the
   * bundle by earlier scene switches. Export/deploy run this first so what
   * you see in the editor is what ships.
   */
  async saveAll(): Promise<number> {
    if (!this.setRef) return 0;
    if (this.dirty && this.sceneFile && this.scene) {
      this.allScenes[this.sceneFile] = JSON.parse(JSON.stringify(this.scene)) as SceneDoc;
    }
    // Snapshot up front: an SSE bundle refresh mid-loop must not swap docs.
    const toSave = Object.entries(this.dirtyFiles)
      .filter(([, d]) => d)
      .map(([file]) => ({ file, doc: this.allScenes[file] }))
      .filter((x): x is { file: string; doc: SceneDoc } => !!x.doc);
    for (const { file, doc } of toSave) {
      this.ownSave = { file, at: Date.now() };
      await fetch('/api/scene', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: this.setRef.root, name: this.setRef.name, file, doc }),
      });
      this.dirtyFiles[file] = false;
    }
    if (this.sceneFile && !this.dirtyFiles[this.sceneFile]) this.dirty = false;
    return toSave.length;
  }

  flash(msg: string): void {
    this.status = msg;
    setTimeout(() => {
      if (this.status === msg) this.status = '';
    }, 4000);
  }
}

export const ed = new EditorState();

// ---- animatable property catalog (Inspector + Timeline share this) ----------

export interface PropDef {
  prop: string;
  label: string;
  fallback: number;
  /** stored 0–1 / ×1, shown as % */
  pct?: boolean;
}

export const TRANSFORM_PROPS: PropDef[] = [
  { prop: 'x', label: 'X', fallback: 0 },
  { prop: 'y', label: 'Y', fallback: 0 },
  { prop: 'scaleX', label: 'Scale X %', fallback: 1, pct: true },
  { prop: 'scaleY', label: 'Scale Y %', fallback: 1, pct: true },
  { prop: 'rotation', label: 'Rotation °', fallback: 0 },
  { prop: 'width', label: 'W', fallback: 0 },
  { prop: 'height', label: 'H', fallback: 0 },
  { prop: 'opacity', label: 'Opacity %', fallback: 1, pct: true },
  { prop: 'fontSize', label: 'Font size', fallback: 24 },
];

export const FILTER_PROP_DEFS: PropDef[] = [
  { prop: 'filterBlur', label: 'Blur px', fallback: 0 },
  { prop: 'filterBrightness', label: 'Brightness %', fallback: 1, pct: true },
  { prop: 'filterContrast', label: 'Contrast %', fallback: 1, pct: true },
  { prop: 'filterGrayscale', label: 'Grayscale %', fallback: 0, pct: true },
  { prop: 'filterHueRotate', label: 'Hue rotate °', fallback: 0 },
  { prop: 'filterInvert', label: 'Invert %', fallback: 0, pct: true },
  { prop: 'filterOpacity', label: 'Filter opacity %', fallback: 1, pct: true },
  { prop: 'filterSaturate', label: 'Saturate %', fallback: 1, pct: true },
  { prop: 'filterSepia', label: 'Sepia %', fallback: 0, pct: true },
];

export const MASK_PROP_DEFS: PropDef[] = [
  { prop: 'x', label: 'X', fallback: 0 },
  { prop: 'y', label: 'Y', fallback: 0 },
  { prop: 'width', label: 'W', fallback: 0 },
  { prop: 'height', label: 'H', fallback: 0 },
];

/** Display value of a property per its def (percent props shown ×100). */
export function dispPropValue(p: StyleProperty | undefined, def: PropDef, frame: number): number {
  const v = propNumber(p, frame, def.fallback) * (def.pct ? 100 : 1);
  return Math.round(v * 100) / 100;
}

/**
 * The one display name of a layer: the element's KEY when bound, the stored
 * name when a human wrote one, otherwise a label derived from the element.
 */
function sceneNameOf(file: string): string {
  return file.replace(/^scenes\//, '').replace(/\.json$/, '');
}

/**
 * Files that belong to an image sequence (numbered runs of ≥3 sharing a
 * prefix — the sidebar's grouping rule). Used to exclude frames from
 * single-image pickers like the loader-placeholder autocomplete.
 */
export function sequenceFrameFiles(assets: AssetInfo[]): Set<string> {
  const groups = new Map<string, string[]>();
  for (const a of assets) {
    const m = /^(.*?)\d{2,}\.(png|jpe?g|webp|gif)$/i.exec(a.file);
    if (!m) continue;
    const key = `${m[1]}#.${m[2]}`;
    const list = groups.get(key) ?? [];
    list.push(a.file);
    groups.set(key, list);
  }
  const frames = new Set<string>();
  for (const list of groups.values()) {
    if (list.length >= 3) for (const f of list) frames.add(f);
  }
  return frames;
}

/** Sequence name: `assets/foo/bar_00001.png` → `foo/bar`; digits-only filenames fall back to the folder. */
export function sequencePattern(frames: string[]): string {
  const first = frames[0];
  if (!first) return 'sequence';
  const parts = first.replace(/^assets\//, '').split('/');
  const stem = (parts.pop() ?? '').replace(/\d{2,}\.\w+$/, '').replace(/[_\-. ]+$/, '');
  const folder = parts.join('/');
  return stem ? (folder ? `${folder}/${stem}` : stem) : folder || 'sequence';
}

export function layerLabel(layer: Layer): string {
  const el = layer.element;
  if (el.key) return el.key;
  if (layer.name) return layer.name;
  switch (el.type) {
    case 'image':
      return 'image ' + el.asset.replace(/^assets\//, '');
    case 'imageSequence':
      return `${sequencePattern(el.frames)} (${el.frames.length})`;
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
