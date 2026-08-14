<script lang="ts">
  import { ed, type AssetInfo } from './state.svelte.ts';

  // collapsed state per section, remembered across sessions
  const stored = JSON.parse(localStorage.getItem('riposte.sidebar.collapsed') ?? '{}') as Record<string, boolean>;
  let collapsed = $state<Record<string, boolean>>({ sets: false, scenes: false, components: true, assets: true, ...stored });

  function toggle(section: string): void {
    collapsed[section] = !collapsed[section];
    localStorage.setItem('riposte.sidebar.collapsed', JSON.stringify(collapsed));
  }

  let assetFilter = $state('');
  const FONT_RE = /\.(ttf|otf|woff2?)$/i;
  type AssetKind = 'images' | 'fonts' | 'all';
  let assetKind = $state<AssetKind>((localStorage.getItem('riposte.assetKind') as AssetKind) ?? 'images');
  /** 'frames' floats sequences to the top, sorted by frame count — for duplicate hunting. */
  let assetSort = $state<'name' | 'frames'>('name');

  function setKind(k: AssetKind): void {
    assetKind = k;
    localStorage.setItem('riposte.assetKind', k);
  }

  const usage = $derived(ed.assetUsage);
  const unused = $derived(ed.unusedAssets);
  const unusedMb = $derived((unused.reduce((s, a) => s + a.size, 0) / 1024 / 1024).toFixed(1));

  type AssetRow =
    | { kind: 'file'; a: AssetInfo }
    | { kind: 'seq'; id: string; label: string; files: AssetInfo[] };

  let openSeqs = $state<Record<string, boolean>>({});

  /** Numbered runs (frame_00001.png …) collapse into one sequence row. */
  function seqKeyOf(file: string): { key: string; prefix: string } | null {
    const m = /^(.*?)(\d{2,})\.(png|jpe?g|webp|gif)$/i.exec(file);
    return m ? { key: `${m[1]}#.${m[3]}`, prefix: m[1] } : null;
  }

  const assetRows = $derived.by(() => {
    const q = assetFilter.trim().toLowerCase();
    const matchesKind = (f: string) =>
      assetKind === 'all' || (assetKind === 'fonts') === FONT_RE.test(f);
    const groups = new Map<string, AssetInfo[]>();
    const singles: AssetInfo[] = [];
    for (const a of ed.assets) {
      if (!matchesKind(a.file)) continue;
      const sk = seqKeyOf(a.file);
      if (sk) {
        const list = groups.get(sk.key) ?? [];
        list.push(a);
        groups.set(sk.key, list);
      } else singles.push(a);
    }
    const rows: AssetRow[] = [];
    for (const [key, files] of groups) {
      if (files.length < 3) {
        singles.push(...files); // 1–2 numbered files are not a sequence
        continue;
      }
      files.sort((x, y) => x.file.localeCompare(y.file, undefined, { numeric: true }));
      const label = key.replace(/^assets\//, '').replace('#', '###');
      if (q && !label.toLowerCase().includes(q) && !files.some((f) => f.file.toLowerCase().includes(q))) continue;
      rows.push({ kind: 'seq', id: key, label, files });
    }
    for (const a of singles) {
      if (q && !a.file.toLowerCase().includes(q)) continue;
      rows.push({ kind: 'file', a });
    }
    if (assetSort === 'frames') {
      const count = (r: AssetRow) => (r.kind === 'seq' ? r.files.length : Infinity);
      rows.sort((x, y) => count(x) - count(y)
        || (x.kind === 'seq' ? x.label : x.a.file).localeCompare(y.kind === 'seq' ? y.label : y.a.file));
    } else {
      rows.sort((x, y) => (x.kind === 'seq' ? x.label : x.a.file).localeCompare(y.kind === 'seq' ? y.label : y.a.file));
    }
    return rows;
  });

  /** Scenes using any frame of a group. */
  function seqUsage(files: AssetInfo[]): string[] {
    const out = new Set<string>();
    for (const f of files) for (const s of usage.get(f.file) ?? []) out.add(s);
    return [...out];
  }

  function seqMb(files: AssetInfo[]): string {
    return (files.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1);
  }

  function dragStartSeq(ev: DragEvent, files: AssetInfo[]): void {
    ev.dataTransfer?.setData('text/riposte-sequence', JSON.stringify(files.map((f) => f.file)));
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
  }

  function sceneName(file: string): string {
    return file.replace(/^scenes\//, '').replace(/\.json$/, '');
  }

  // ---- inline renaming -------------------------------------------------------
  /** What is being renamed: a scene/component file, an asset file, or a whole sequence. */
  let renaming = $state<{ kind: 'scene' | 'asset' | 'seq'; file: string; value: string; files?: string[] } | null>(null);

  function startRename(kind: 'scene' | 'asset', file: string): void {
    renaming = { kind, file, value: kind === 'scene' ? sceneName(file) : file.replace(/^assets\//, '') };
  }

  /** Suggest the folder name if all frames share one, else the filename prefix. */
  function startRenameSeq(row: { id: string; label: string; files: AssetInfo[] }): void {
    const folders = new Set(row.files.map((f) => f.file.split('/').slice(1, -1).join('/')));
    const folder = folders.size === 1 ? [...folders][0] : '';
    const prefix = (row.label.split('/').pop() ?? '').replace(/#+\.\w+$/, '').replace(/[_\-. ]+$/, '');
    renaming = { kind: 'seq', file: row.id, value: folder || prefix, files: row.files.map((f) => f.file) };
  }

  function commitRename(): void {
    if (!renaming) return;
    const { kind, file, value, files } = renaming;
    renaming = null;
    if (kind === 'scene') void ed.renameScene(file, value);
    else if (kind === 'seq') void ed.renameSequence(files ?? [], value);
    else void ed.renameAsset(file, `assets/${value.trim()}`);
  }

  function renameKeys(ev: KeyboardEvent): void {
    if (ev.key === 'Enter') commitRename();
    else if (ev.key === 'Escape') renaming = null;
  }

  // ---- per-scene visibility filter --------------------------------------------
  // View-only: hides a scene from this list (per set, remembered); export/deploy
  // are unaffected. The header eye flips between "only visible" and "show all".
  let showHidden = $state(localStorage.getItem('riposte.showHiddenScenes') === '1');
  let hiddenScenes = $state<Record<string, boolean>>({});
  const hiddenKey = $derived(ed.setRef ? `riposte.hiddenScenes.${ed.setRef.root}/${ed.setRef.name}` : '');

  $effect(() => {
    hiddenScenes = hiddenKey
      ? (JSON.parse(localStorage.getItem(hiddenKey) ?? '{}') as Record<string, boolean>)
      : {};
  });

  const hiddenCount = $derived(ed.setRef ? ed.setRef.scenes.filter((f) => hiddenScenes[f]).length : 0);
  const visibleScenes = $derived(
    ed.setRef ? ed.setRef.scenes.filter((f) => showHidden || !hiddenScenes[f]) : [],
  );

  function toggleShowHidden(): void {
    showHidden = !showHidden;
    localStorage.setItem('riposte.showHiddenScenes', showHidden ? '1' : '0');
  }

  function toggleSceneHidden(file: string): void {
    if (hiddenScenes[file]) delete hiddenScenes[file];
    else hiddenScenes[file] = true;
    if (hiddenKey) localStorage.setItem(hiddenKey, JSON.stringify(hiddenScenes));
  }

  const DRAGGABLE_RE = /\.(png|jpe?g|webp|svg|gif)$/i;

  function dragStart(ev: DragEvent, file: string): void {
    ev.dataTransfer?.setData('text/riposte-asset', file);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
  }

  // ---- asset preview panel ----------------------------------------------------
  // Hovering an asset row shows it in a pane pinned under the list; the last
  // hovered asset stays up (acts like a selection without costing a click).
  let previewOn = $state(localStorage.getItem('riposte.assetPreview') !== '0');
  let previewFile = $state<string | null>(null);
  let previewDim = $state('');

  function togglePreview(): void {
    previewOn = !previewOn;
    localStorage.setItem('riposte.assetPreview', previewOn ? '1' : '0');
  }

  function setPreview(file: string): void {
    if (previewFile === file) return;
    previewFile = file;
    previewDim = '';
  }

  const previewIsImg = $derived(previewFile !== null && DRAGGABLE_RE.test(previewFile));
  const previewIsFont = $derived(previewFile !== null && FONT_RE.test(previewFile));
  const previewSize = $derived.by(() => {
    const a = ed.assets.find((x) => x.file === previewFile);
    if (!a) return '';
    return a.size >= 1024 * 1024 ? `${(a.size / 1024 / 1024).toFixed(1)} MB` : `${(a.size / 1024).toFixed(1)} KB`;
  });

  // Fonts preview via a live FontFace so the sample renders in the actual font.
  let previewFontFamily = $state('');
  let loadedFace: FontFace | null = null;
  $effect(() => {
    if (!previewOn || !previewFile || !FONT_RE.test(previewFile)) return;
    const face = new FontFace('riposte-asset-preview', `url("${ed.assetBase}${previewFile}")`);
    previewFontFamily = '';
    void face
      .load()
      .then(() => {
        if (loadedFace) document.fonts.delete(loadedFace);
        loadedFace = face;
        document.fonts.add(face);
        previewFontFamily = 'riposte-asset-preview';
      })
      .catch(() => {});
  });

  function previewImgLoaded(ev: Event): void {
    const img = ev.currentTarget as HTMLImageElement;
    if (img.naturalWidth) previewDim = `${img.naturalWidth}×${img.naturalHeight}`;
  }

  // ---- file pickers (new set from .loo, .set archive, asset upload) ----------
  let looInput = $state<HTMLInputElement>();
  let setInput = $state<HTMLInputElement>();
  let assetInput = $state<HTMLInputElement>();

  function pickedLoo(): void {
    const files = [...(looInput?.files ?? [])];
    if (looInput) looInput.value = '';
    void ed.importLooFiles(files);
  }

  function pickedSet(): void {
    const files = [...(setInput?.files ?? [])];
    if (setInput) setInput.value = '';
    void ed.openSetFiles(files);
  }

  function pickedAssets(): void {
    const files = [...(assetInput?.files ?? [])];
    if (assetInput) assetInput.value = '';
    void ed.uploadAssets(files);
  }
</script>

{#snippet renameInput()}
  <input
    class="rename"
    type="text"
    value={renaming?.value ?? ''}
    oninput={(e) => { if (renaming) renaming.value = (e.currentTarget as HTMLInputElement).value; }}
    onkeydown={renameKeys}
    onblur={commitRename}
    {@attach (node) => { (node as HTMLInputElement).focus(); (node as HTMLInputElement).select(); }}
  />
{/snippet}

<aside>
  <input class="ghost" type="file" multiple accept=".loo" bind:this={looInput} onchange={pickedLoo} />
  <input class="ghost" type="file" multiple accept=".set" bind:this={setInput} onchange={pickedSet} />
  <input class="ghost" type="file" multiple accept="image/*,.png,.jpg,.jpeg,.webp,.svg,.gif,.ttf,.otf,.woff,.woff2" bind:this={assetInput} onchange={pickedAssets} />

  <h2 class="hrow">
    <button class="linkish" onclick={() => toggle('sets')}>{collapsed.sets ? '▸' : '▾'} Sets</button>
    <button class="hbtn wide" title="Open a .set archive — import a set saved from another machine" onclick={() => setInput?.click()}>open</button>
    <button class="hbtn wide" title="Import Loopic .loo project files into a new or existing set" onclick={() => looInput?.click()}>+ .loo</button>
    <button class="hbtn" title="New empty set" onclick={() => ed.createSet()}>+</button>
  </h2>
  {#if !collapsed.sets}
    <ul class="sets">
      {#each ed.sets as s (s.root + s.name)}
        <li class="set-row">
          <button
            class:active={ed.setRef?.root === s.root && ed.setRef?.name === s.name}
            title="Click to open the set (pick a scene below) — double-click for set options"
            onclick={() => { if (ed.setRef !== s) void ed.openSet(s, { openFirst: false }); }}
            ondblclick={() => { if (ed.setRef === s) ed.setOptionsOpen = true; }}
          >
            {s.name}
            <span class="dim">{s.root === 'examples' ? 'demo' : ''}</span>
          </button>
          {#if s.root === 'projects'}
            <button class="rowbtn" title="Save as .set archive — portable single file for another machine" onclick={(e) => { e.stopPropagation(); void ed.saveSetFile(s); }}>⤓</button>
            <button class="rowbtn" title="Duplicate set" onclick={(e) => { e.stopPropagation(); void ed.duplicateSet(s); }}>⧉</button>
            <button class="rowbtn remove" title="Delete set" onclick={(e) => { e.stopPropagation(); void ed.deleteSet(s); }}>✕</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if ed.setRef}
    <h2 class="hrow">
      <button class="linkish" onclick={() => toggle('scenes')}>
        {collapsed.scenes ? '▸' : '▾'} Scenes
        <span class="dim">({hiddenCount ? `${ed.setRef.scenes.length - hiddenCount}/` : ''}{ed.setRef.scenes.length})</span>
      </button>
      {#if hiddenCount > 0 || showHidden}
        <button
          class="hbtn"
          class:on={showHidden}
          title={showHidden ? 'Showing all scenes — click to filter out the hidden ones' : `Show ${hiddenCount} hidden scene${hiddenCount === 1 ? '' : 's'}`}
          onclick={toggleShowHidden}
        >👁</button>
      {/if}
      <button class="hbtn" title="New scene" onclick={() => ed.newScene()}>+</button>
    </h2>
    {#if !collapsed.scenes}
      <ul class="scenes">
        {#each visibleScenes as file (file)}
          <li class="scene-row" class:ghosted={hiddenScenes[file]}>
            {#if renaming?.kind === 'scene' && renaming.file === file}
              {@render renameInput()}
            {:else}
              <button
                class:active={ed.sceneFile === file}
                title="double-click to rename"
                onclick={() => ed.openScene(file)}
                ondblclick={() => startRename('scene', file)}
              >
                {sceneName(file)}{#if ed.dirtyFiles[file]}<span class="unsaved" title="unsaved changes"> ●</span>{/if}
              </button>
              <button
                class="rowbtn eye"
                class:off={hiddenScenes[file]}
                title={hiddenScenes[file] ? 'Hidden — click to show in the list again' : 'Hide from this list (view only — export/deploy unaffected)'}
                onclick={() => toggleSceneHidden(file)}
              >👁</button>
              <button class="rowbtn" title="Make this a component — reusable, embeddable in scenes (moves to the Components list; not exported as its own template)" onclick={() => ed.convertScene(file, 'component')}>▣</button>
              <button class="rowbtn" title="Duplicate scene" onclick={() => ed.duplicateScene(file)}>⧉</button>
              <button class="rowbtn remove" title="Delete scene (file included)" onclick={() => ed.removeScene(file)}>✕</button>
            {/if}
          </li>
        {/each}
        {#if visibleScenes.length === 0}
          <li class="dim allhidden">all {ed.setRef.scenes.length} scenes hidden — 👁 in the header shows them</li>
        {/if}
      </ul>
    {/if}

    {#if ed.setRef.components.length > 0}
      <h2>
        <button class="linkish" onclick={() => toggle('components')}>
          {collapsed.components ? '▸' : '▾'} Components <span class="dim">({ed.setRef.components.length})</span>
        </button>
      </h2>
      {#if !collapsed.components}
        <ul class="scenes">
          {#each ed.setRef.components as file (file)}
            <li
              class="scene-row"
              draggable="true"
              ondragstart={(e) => {
                e.dataTransfer?.setData('text/riposte-component', file);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
              }}
            >
              {#if renaming?.kind === 'scene' && renaming.file === file}
                {@render renameInput()}
              {:else}
                <button
                  class:active={ed.sceneFile === file}
                  title="click to edit, double-click to rename, drag to the stage to embed it in the open scene"
                  onclick={() => ed.openScene(file)}
                  ondblclick={() => startRename('scene', file)}
                >
                  ▣ {sceneName(file)}{#if ed.dirtyFiles[file]}<span class="unsaved" title="unsaved changes"> ●</span>{/if}
                </button>
                <button class="rowbtn" title="Make this a regular scene again (refused while it's still embedded somewhere)" onclick={() => ed.convertScene(file, 'scene')}>⇄</button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}

    <h2 class="hrow">
      <button class="linkish" onclick={() => toggle('assets')}>
        {collapsed.assets ? '▸' : '▾'} Assets
        <span class="dim">({ed.assets.length}{unused.length ? `, ${unused.length} unused` : ''})</span>
      </button>
      <button class="hbtn" class:on={previewOn} title="Toggle the asset preview pane (hover an asset to preview it)" onclick={togglePreview}>👁</button>
      <button class="hbtn" title="Upload images / fonts into this set" onclick={() => assetInput?.click()}>+</button>
    </h2>
    {#if !collapsed.assets}
      {#if unused.length > 0}
        <button class="danger" onclick={() => ed.deleteUnusedAssets()}>
          Delete {unused.length} unused ({unusedMb} MB)
        </button>
      {/if}
      <div class="kinds">
        {#each ['images', 'fonts', 'all'] as k (k)}
          <button class="kind" class:on={assetKind === k} onclick={() => setKind(k as AssetKind)}>{k}</button>
        {/each}
        <span class="gap"></span>
        <button
          class="kind"
          class:on={assetSort === 'frames'}
          title="Sort sequences to the top by frame count (spot near-duplicates)"
          onclick={() => (assetSort = assetSort === 'name' ? 'frames' : 'name')}
        >#⇅</button>
      </div>
      <input class="filter" type="search" placeholder="filter assets…" bind:value={assetFilter} />
      <ul class="assets">
        {#each assetRows as row (row.kind === 'seq' ? row.id : row.a.file)}
          {#if row.kind === 'seq'}
            {@const seqUsed = seqUsage(row.files)}
            <li
              class="seq"
              class:unused={seqUsed.length === 0}
              title={(seqUsed.length ? `used by:\n${seqUsed.join('\n')}` : 'UNUSED') + `\n\n${row.files.length} frames, ${seqMb(row.files)} MB. Double-click to rename the sequence, drag to stage or timeline for an image sequence.`}
              draggable="true"
              ondragstart={(e) => dragStartSeq(e, row.files)}
              onmouseenter={() => setPreview(row.files[row.files.length - 1]!.file)}
            >
              <button class="fold" onclick={() => (openSeqs[row.id] = !openSeqs[row.id])}>{openSeqs[row.id] ? '▾' : '▸'}</button>
              {#if renaming?.kind === 'seq' && renaming.file === row.id}
                {@render renameInput()}
              {:else}
                <span
                  class="name"
                  role="button"
                  tabindex="-1"
                  onclick={() => (openSeqs[row.id] = !openSeqs[row.id])}
                  ondblclick={() => startRenameSeq(row)}
                >{row.label} ({row.files.length})</span>
                <span class="dim">{seqUsed.length || '—'}</span>
              {/if}
            </li>
            {#if openSeqs[row.id]}
              {#each row.files as a (a.file)}
                <li class="frame" draggable={true} ondragstart={(e) => dragStart(e, a.file)} onmouseenter={() => setPreview(a.file)}>
                  {#if renaming?.kind === 'asset' && renaming.file === a.file}
                    {@render renameInput()}
                  {:else}
                    <span class="name" role="button" tabindex="-1" ondblclick={() => startRename('asset', a.file)}>
                      {a.file.split('/').pop()}
                    </span>
                  {/if}
                </li>
              {/each}
            {/if}
          {:else}
            {@const a = row.a}
            {@const used = usage.get(a.file)}
            <li
              class:unused={!used}
              title={(used ? `used by:\n${used.join('\n')}` : 'UNUSED') + '\n\ndouble-click to rename, drag to stage or timeline'}
              draggable={DRAGGABLE_RE.test(a.file)}
              ondragstart={(e) => dragStart(e, a.file)}
              onmouseenter={() => setPreview(a.file)}
            >
              {#if renaming?.kind === 'asset' && renaming.file === a.file}
                {@render renameInput()}
              {:else}
                <span
                  class="name"
                  role="button"
                  tabindex="-1"
                  ondblclick={() => startRename('asset', a.file)}
                >{a.file.replace(/^assets\//, '')}</span>
                <span class="dim">{used ? used.length : '—'}</span>
              {/if}
            </li>
          {/if}
        {/each}
        {#if assetRows.length === 0}
          <li class="dim">no match</li>
        {/if}
      </ul>

      {#if previewOn && previewFile && (previewIsImg || previewIsFont)}
        <div class="preview">
          <div class="checker">
            {#if previewIsImg}
              <img src={ed.assetBase + previewFile} alt={previewFile} onload={previewImgLoaded} />
            {:else}
              <span class="fontsample" style:font-family={previewFontFamily || 'inherit'}>AaBb 0123 4:45 HUN</span>
            {/if}
          </div>
          <div class="cap">
            <span class="capname">{previewFile.replace(/^assets\//, '')}</span>
            <span class="dim">{previewIsImg && previewDim ? `${previewDim} · ` : ''}{previewSize}</span>
          </div>
        </div>
      {/if}
    {/if}
  {/if}
</aside>

<style>
  aside {
    overflow: hidden;
    padding: 8px;
    border-right: 1px solid #2c2f38;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 0;
  }
  h2 {
    flex: none;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: #8a8f98;
    margin: 10px 0 4px;
  }
  ul { list-style: none; margin: 0; padding: 0; }
  li button, .linkish {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: #cfd3da;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  h2 .linkish { color: #8a8f98; text-transform: uppercase; letter-spacing: 0.14em; font-size: 11px; padding: 0; }
  h2 .linkish:hover { color: #cfd3da; background: none; }
  li button:hover { background: #23262e; }
  li button.active { background: #2c4a75; color: #fff; }
  /* Lists take their natural height and only shrink (with their own
     scrollbar) when the sidebar runs out of room — so collapsing other
     sections hands the space to whatever stays open. */
  .sets { flex: none; max-height: 20vh; overflow-y: auto; }
  .scenes { flex: 0 1 auto; min-height: 60px; overflow-y: auto; }
  .scene-row { display: flex; align-items: center; }
  .scene-row .rowbtn {
    display: none;
    flex: none;
    width: 22px;
    padding: 2px;
    color: #8a8f98;
    text-align: center;
  }
  .scene-row:hover .rowbtn { display: block; }
  .scene-row .rowbtn:hover { color: #cfd3da; background: #23262e; }
  .scene-row .remove { color: #a55; }
  .scene-row .remove:hover { color: #e07777; background: #2a2020; }
  .set-row { display: flex; align-items: center; }
  .set-row .rowbtn {
    display: none;
    flex: none;
    width: 22px;
    padding: 2px;
    color: #8a8f98;
    text-align: center;
  }
  .set-row:hover .rowbtn { display: block; }
  .set-row .rowbtn:hover { color: #cfd3da; background: #23262e; }
  .set-row .remove { color: #a55; }
  .set-row .remove:hover { color: #e07777; background: #2a2020; }
  /* Hidden scenes (visible while "show all" is on): ghosted, eye always shown. */
  .scene-row.ghosted > button:first-of-type { color: #676c76; }
  .scene-row .eye.off { display: block; opacity: 0.5; }
  .scene-row .eye.off:hover { opacity: 1; }
  .allhidden { padding: 4px 8px; font-size: 12px; white-space: normal; }
  .unsaved { color: #d9a441; }
  .hrow { display: flex; align-items: center; }
  .hrow .linkish { flex: 1; }
  .hbtn {
    flex: none;
    background: #23262e;
    border: 1px solid #383c46;
    color: #cfd3da;
    border-radius: 4px;
    width: 20px;
    height: 18px;
    line-height: 1;
    cursor: pointer;
    font-size: 13px;
    padding: 0;
  }
  .hbtn:hover { background: #2c4a75; }
  .hbtn.wide { width: auto; padding: 0 6px; font-size: 11px; }
  .hbtn.on { background: #2c4a75; color: #fff; }
  .ghost { display: none; }
  .kinds { display: flex; gap: 3px; margin: 2px 0; flex: none; }
  .kinds .gap { flex: 1; }
  .kind {
    background: #23262e;
    border: 1px solid #383c46;
    color: #8a8f98;
    border-radius: 4px;
    padding: 1px 8px;
    font-size: 11px;
    cursor: pointer;
  }
  .kind.on { background: #2c4a75; color: #fff; }
  .filter {
    flex: none;
    background: #23262e;
    color: #e6e6e6;
    border: 1px solid #383c46;
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 12px;
    margin: 2px 0 4px;
  }
  .rename {
    background: #14161b;
    color: #fff;
    border: 1px solid #d9a441;
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 12px;
    width: 100%;
  }
  .assets { flex: 0 1 auto; min-height: 60px; font-size: 12px; overflow-y: auto; }
  .assets li {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 3px 8px;
    color: #aab;
  }
  /* Default arrow at rest: its hotspot is the precise tip, so the pickup row
     matches what the user aims at (the grab hand's hotspot sits lower and
     grabbed the wrong row). The hand only appears once the drag is live. */
  .assets li[draggable='true']:active { cursor: grabbing; }
  .assets li .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .assets li.unused { color: #e0a34e; }
  .assets li.seq { color: #9fb8d8; }
  .assets li.seq.unused { color: #e0a34e; }
  .assets li.seq .fold {
    /* generic `li button` sets width:100% — as a flex item that eats half the row */
    flex: none;
    width: auto;
    background: none;
    border: none;
    color: inherit;
    padding: 0 2px;
    cursor: pointer;
    font-size: 10px;
  }
  .assets li.seq .name { flex: 1; }
  .assets li.frame { padding-left: 26px; color: #7d828c; }
  .dim { color: #676c76; font-size: 11px; }
  .danger {
    flex: none;
    background: #5a2b2b;
    color: #f0c9c9;
    border: 1px solid #7a3a3a;
    border-radius: 5px;
    padding: 5px 10px;
    cursor: pointer;
    font-size: 12px;
  }
  .danger:hover { background: #703434; }
  .preview {
    flex: none;
    border: 1px solid #2c2f38;
    border-radius: 6px;
    overflow: hidden;
    margin-top: 4px;
  }
  /* Checkerboard: most broadcast assets are transparent PNGs. */
  .preview .checker {
    height: 130px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: repeating-conic-gradient(#33363f 0% 25%, #262a31 0% 50%) 0 0 / 16px 16px;
  }
  .preview img {
    max-width: 100%;
    max-height: 126px;
    object-fit: contain;
  }
  .preview .fontsample {
    color: #fff;
    font-size: 24px;
    padding: 0 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .preview .cap {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    padding: 3px 8px;
    font-size: 11px;
    color: #aab;
    background: #1b1d23;
  }
  .preview .cap .capname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .preview .cap .dim { flex: none; }
</style>
