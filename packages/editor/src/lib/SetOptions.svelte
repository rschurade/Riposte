<script lang="ts">
  import { ed } from './state.svelte.ts';

  const e = $derived(ed.setRef?.export ?? {});
  let mode = $state<'external' | 'baked' | 'ograf' | 'spx'>('external');
  let preload = $state(true);
  let fitToWindow = $state(false);
  let imageFormat = $state<'png' | 'webp'>('png');
  let webpQuality = $state<string>('92');

  // re-seed the form whenever the dialog opens for a (possibly different) set
  $effect(() => {
    if (!ed.setOptionsOpen) return;
    mode = e.mode ?? 'external';
    preload = e.preloadAssets ?? true;
    fitToWindow = e.fitToWindow ?? false;
    imageFormat = e.imageFormat ?? 'png';
    webpQuality = String(e.webpQuality ?? 92);
  });

  async function save(): Promise<void> {
    await ed.saveSetSettings({
      mode,
      preloadAssets: preload,
      fitToWindow,
      imageFormat,
      webpQuality: webpQuality === 'lossless' ? 'lossless' : Number(webpQuality),
    });
    ed.setOptionsOpen = false;
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') ed.setOptionsOpen = false;
  }
</script>

<svelte:window onkeydown={onKey} />

{#if ed.setOptionsOpen && ed.setRef}
  <div class="overlay" role="presentation" onclick={() => (ed.setOptionsOpen = false)}>
    <div class="dialog" role="dialog" aria-label="Set options" onclick={(ev) => ev.stopPropagation()}>
      <h2>{ed.setRef.name} <span class="dim">set options</span></h2>
      <p class="meta">{ed.setRef.scenes.length} scenes · {ed.setRef.components.length} components · {ed.setRef.fonts.length} fonts</p>

      <div class="grid">
        <label for="so-mode">Export mode</label>
        <select id="so-mode" bind:value={mode}>
          <option value="external">external — shells + shared assets (default)</option>
          <option value="baked">baked — single-file HTML (compat)</option>
          <option value="spx">SPX — external + SPXGCTemplateDefinition</option>
          <option value="ograf">OGraf — manifest + graphic.mjs (EBU standard)</option>
        </select>

        <label for="so-preload">Preload assets</label>
        <input id="so-preload" type="checkbox" bind:checked={preload} title="Fetch all assets at template load — prevents first-ADD flash" />

        <label for="so-fit-window">Fit to output window</label>
        <input id="so-fit-window" type="checkbox" bind:checked={fitToWindow} title="Scale HTML exports to the browser viewport, matching Loopic's fitToWindow behavior" />

        <label for="so-format">Images</label>
        <select id="so-format" bind:value={imageFormat}>
          <option value="png">PNG — copied untouched</option>
          <option value="webp">WebP — re-encoded at export, 3-10× smaller</option>
        </select>

        {#if imageFormat === 'webp'}
          <label for="so-quality">WebP quality</label>
          <select id="so-quality" bind:value={webpQuality}>
            <option value="lossless">lossless — bit-perfect</option>
            <option value="95">95 — near-transparent</option>
            <option value="92">92 — recommended</option>
            <option value="85">85 — aggressive</option>
          </select>
        {/if}
      </div>

      {#if imageFormat === 'webp'}
        <p class="hint">
          Re-encoding only changes the exported copies — scene files keep their PNGs.
          Lossy exports also try lossless per image and ship whichever is smaller.
          The first export encodes everything (a few minutes for a big set); after
          that a content cache makes it instant.
        </p>
      {/if}

      <div class="row">
        <button
          title="Copy the app's stock intro/outro presets into this set — only missing ones, existing files are never overwritten"
          onclick={() => ed.addStockPresets()}
        >+ stock presets</button>
        <span class="spacer"></span>
        <button class="primary" onclick={save}>Save</button>
        <button onclick={() => (ed.setOptionsOpen = false)}>Close</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(10, 11, 14, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 20000;
  }
  .dialog {
    background: #1b1e24;
    border: 1px solid #3a3e48;
    border-radius: 8px;
    padding: 18px 20px;
    width: 470px;
    max-width: 90vw;
    color: #e6e6e6;
  }
  h2 { margin: 0 0 2px; font-size: 15px; }
  .dim { color: #8a8f98; font-weight: 400; font-size: 12px; }
  .meta { color: #8a8f98; font-size: 11px; margin: 0 0 14px; }
  .grid { display: grid; grid-template-columns: max-content 1fr; gap: 8px 12px; align-items: center; }
  label { font-size: 12px; color: #aab; }
  select { background: #23262e; color: #e6e6e6; border: 1px solid #383c46; border-radius: 5px; padding: 5px 8px; font-size: 12px; }
  .hint { font-size: 11px; color: #8a8f98; line-height: 1.5; margin: 12px 0 0; }
  .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  .spacer { flex: 1; }
  button { background: #23262e; color: #e6e6e6; border: 1px solid #383c46; border-radius: 5px; padding: 6px 14px; font-size: 12px; cursor: pointer; }
  button:hover { border-color: #d9a441; }
  .primary { background: #2c4a75; }
</style>
