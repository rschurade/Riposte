<script lang="ts">
  import { ed } from './state.svelte.ts';

  let showAssets = $state(false);

  const usage = $derived(ed.assetUsage);
  const unused = $derived(ed.unusedAssets);
  const unusedMb = $derived((unused.reduce((s, a) => s + a.size, 0) / 1024 / 1024).toFixed(1));

  function sceneName(file: string): string {
    return file.replace(/^scenes\//, '').replace(/\.json$/, '');
  }
</script>

<aside>
  <h2>Sets</h2>
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

  {#if ed.setRef}
    <h2>Scenes <span class="dim">({ed.setRef.scenes.length})</span></h2>
    <ul class="scenes">
      {#each ed.setRef.scenes as file (file)}
        <li class="scene-row">
          <button class:active={ed.sceneFile === file} onclick={() => ed.openScene(file)}>
            {sceneName(file)}
          </button>
          <button class="remove" title="Remove scene from set" onclick={() => ed.removeScene(file)}>✕</button>
        </li>
      {/each}
    </ul>

    <h2>
      <button class="linkish" onclick={() => (showAssets = !showAssets)}>
        Assets <span class="dim">({ed.assets.length}{unused.length ? `, ${unused.length} unused` : ''})</span>
        {showAssets ? '▾' : '▸'}
      </button>
    </h2>
    {#if unused.length > 0}
      <button class="danger" onclick={() => ed.deleteUnusedAssets()}>
        Delete {unused.length} unused ({unusedMb} MB)
      </button>
    {/if}
    {#if showAssets}
      <ul class="assets">
        {#each ed.assets as a (a.file)}
          {@const used = usage.get(a.file)}
          <li class:unused={!used} title={used ? `used by: ${used.join(', ')}` : 'UNUSED'}>
            <span class="name">{a.file.replace(/^assets\//, '')}</span>
            <span class="dim">{used ? used.length : '—'}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</aside>

<style>
  aside {
    overflow-y: auto;
    padding: 8px;
    border-right: 1px solid #2c2f38;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 0;
  }
  h2 {
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
  li button:hover { background: #23262e; }
  li button.active { background: #2c4a75; color: #fff; }
  .scenes { max-height: 40vh; overflow-y: auto; }
  .scene-row { display: flex; align-items: center; }
  .scene-row .remove {
    display: none;
    flex: none;
    width: 22px;
    padding: 2px;
    color: #a55;
    text-align: center;
  }
  .scene-row:hover .remove { display: block; }
  .scene-row .remove:hover { color: #e07777; background: #2a2020; }
  .assets { font-size: 12px; max-height: 30vh; overflow-y: auto; }
  .assets li {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 2px 8px;
    color: #aab;
  }
  .assets li .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .assets li.unused { color: #e0a34e; }
  .dim { color: #676c76; font-size: 11px; }
  .danger {
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
