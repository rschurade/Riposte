<script lang="ts">
  import { ed } from './state.svelte.ts';

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

  function setKind(k: AssetKind): void {
    assetKind = k;
    localStorage.setItem('riposte.assetKind', k);
  }

  const usage = $derived(ed.assetUsage);
  const unused = $derived(ed.unusedAssets);
  const unusedMb = $derived((unused.reduce((s, a) => s + a.size, 0) / 1024 / 1024).toFixed(1));
  const filteredAssets = $derived.by(() => {
    const q = assetFilter.trim().toLowerCase();
    return ed.assets.filter((a) => {
      if (assetKind === 'images' && FONT_RE.test(a.file)) return false;
      if (assetKind === 'fonts' && !FONT_RE.test(a.file)) return false;
      return q === '' || a.file.toLowerCase().includes(q);
    });
  });

  function sceneName(file: string): string {
    return file.replace(/^scenes\//, '').replace(/\.json$/, '');
  }

  // ---- inline renaming -------------------------------------------------------
  /** What is being renamed: a scene/component file or an asset file. */
  let renaming = $state<{ kind: 'scene' | 'asset'; file: string; value: string } | null>(null);

  function startRename(kind: 'scene' | 'asset', file: string): void {
    renaming = { kind, file, value: kind === 'scene' ? sceneName(file) : file.replace(/^assets\//, '') };
  }

  function commitRename(): void {
    if (!renaming) return;
    const { kind, file, value } = renaming;
    renaming = null;
    if (kind === 'scene') void ed.renameScene(file, value);
    else void ed.renameAsset(file, `assets/${value.trim()}`);
  }

  function renameKeys(ev: KeyboardEvent): void {
    if (ev.key === 'Enter') commitRename();
    else if (ev.key === 'Escape') renaming = null;
  }

  const DRAGGABLE_RE = /\.(png|jpe?g|webp|svg|gif)$/i;

  function dragStart(ev: DragEvent, file: string): void {
    ev.dataTransfer?.setData('text/riposte-asset', file);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
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
  <h2><button class="linkish" onclick={() => toggle('sets')}>{collapsed.sets ? '▸' : '▾'} Sets</button></h2>
  {#if !collapsed.sets}
    <ul class="sets">
      {#each ed.sets as s (s.root + s.name)}
        <li>
          <button
            class:active={ed.setRef?.root === s.root && ed.setRef?.name === s.name}
            onclick={() => ed.openSet(s)}
          >
            {s.name}
            <span class="dim">{s.root === 'examples' ? 'demo' : ''}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if ed.setRef}
    <h2 class="hrow">
      <button class="linkish" onclick={() => toggle('scenes')}>
        {collapsed.scenes ? '▸' : '▾'} Scenes <span class="dim">({ed.setRef.scenes.length})</span>
      </button>
      <button class="hbtn" title="New scene" onclick={() => ed.newScene()}>+</button>
    </h2>
    {#if !collapsed.scenes}
      <ul class="scenes">
        {#each ed.setRef.scenes as file (file)}
          <li class="scene-row">
            {#if renaming?.kind === 'scene' && renaming.file === file}
              {@render renameInput()}
            {:else}
              <button
                class:active={ed.sceneFile === file}
                title="double-click to rename"
                onclick={() => ed.openScene(file)}
                ondblclick={() => startRename('scene', file)}
              >
                {sceneName(file)}
              </button>
              <button class="rowbtn" title="Duplicate scene" onclick={() => ed.duplicateScene(file)}>⧉</button>
              <button class="rowbtn remove" title="Delete scene (file included)" onclick={() => ed.removeScene(file)}>✕</button>
            {/if}
          </li>
        {/each}
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
            <li class="scene-row">
              {#if renaming?.kind === 'scene' && renaming.file === file}
                {@render renameInput()}
              {:else}
                <button
                  class:active={ed.sceneFile === file}
                  title="double-click to rename"
                  onclick={() => ed.openScene(file)}
                  ondblclick={() => startRename('scene', file)}
                >
                  ▣ {sceneName(file)}
                </button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}

    <h2>
      <button class="linkish" onclick={() => toggle('assets')}>
        {collapsed.assets ? '▸' : '▾'} Assets
        <span class="dim">({ed.assets.length}{unused.length ? `, ${unused.length} unused` : ''})</span>
      </button>
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
      </div>
      <input class="filter" type="search" placeholder="filter assets…" bind:value={assetFilter} />
      <ul class="assets">
        {#each filteredAssets as a (a.file)}
          {@const used = usage.get(a.file)}
          <li
            class:unused={!used}
            title={(used ? `used by: ${used.join(', ')}` : 'UNUSED') + ' — double-click to rename, drag to timeline'}
            draggable={DRAGGABLE_RE.test(a.file)}
            ondragstart={(e) => dragStart(e, a.file)}
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
        {/each}
        {#if filteredAssets.length === 0}
          <li class="dim">no match</li>
        {/if}
      </ul>
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
  .kinds { display: flex; gap: 3px; margin: 2px 0; flex: none; }
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
    padding: 2px 8px;
    color: #aab;
  }
  .assets li[draggable='true'] { cursor: grab; }
  .assets li .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .assets li.unused { color: #e0a34e; }
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
</style>
