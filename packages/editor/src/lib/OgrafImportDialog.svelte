<script lang="ts">
  import { ed } from './state.svelte.ts';

  let ografDir = $state('');
  let setName = $state('');
  let busy = $state(false);

  $effect(() => {
    if (!ed.ografImportDialogOpen) return;
    ografDir = '';
    setName = ed.setRef?.root === 'projects' ? ed.setRef.name : '';
    busy = false;
  });

  async function doImport(): Promise<void> {
    if (!ografDir.trim() || !setName.trim() || busy) return;
    busy = true;
    await ed.importOgrafSet(ografDir.trim(), setName.trim());
  }

  function onKey(ev: KeyboardEvent): void {
    if (!ed.ografImportDialogOpen) return;
    if (ev.key === 'Escape') ed.ografImportDialogOpen = false;
    if (ev.key === 'Enter') void doImport();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if ed.ografImportDialogOpen}
  <div class="overlay" role="presentation" onclick={() => (ed.ografImportDialogOpen = false)}>
    <div class="dialog" role="dialog" aria-label="Import OGraf" onclick={(ev) => ev.stopPropagation()}>
      <h2>Import OGraf graphic <span class="dim">— folder on disk</span></h2>

      <label class="lbl" for="oi-path">OGraf folder path</label>
      <input
        id="oi-path"
        type="text"
        bind:value={ografDir}
        placeholder="e.g. C:\ograf\my-graphic"
        spellcheck="false"
        disabled={busy}
        {@attach (node) => { (node as HTMLInputElement).focus(); }}
      />

      <label class="lbl" for="oi-set">Into set</label>
      <input
        id="oi-set"
        type="text"
        bind:value={setName}
        placeholder="Existing set name or new one"
        spellcheck="false"
        disabled={busy}
      />

      <p class="hint">
        The OGraf folder must contain a <code>*.ograf.json</code> manifest and a
        <code>graphic.mjs</code> implementation. The manifest's schema determines
        data-binding keys; moderate code parsing extracts basic elements, colors,
        and positions. GSAP animations are approximated as Riposte keyframes.
      </p>

      <div class="row">
        <button class="primary" onclick={doImport} disabled={!ografDir.trim() || !setName.trim() || busy}>
          {busy ? '…' : 'Import'}
        </button>
        <button onclick={() => (ed.ografImportDialogOpen = false)} disabled={busy}>Cancel</button>
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
  h2 { margin: 0 0 14px; font-size: 15px; }
  .dim { color: #8a8f98; font-weight: 400; font-size: 12px; }
  .lbl { display: block; font-size: 12px; color: #aab; margin-bottom: 4px; margin-top: 10px; }
  .lbl:first-of-type { margin-top: 0; }
  input[type='text'] {
    width: 100%;
    box-sizing: border-box;
    background: #23262e;
    color: #e6e6e6;
    border: 1px solid #383c46;
    border-radius: 5px;
    padding: 6px 8px;
    font-size: 12px;
  }
  .hint { font-size: 11px; color: #8a8f98; line-height: 1.5; margin: 12px 0 0; }
  .hint code { background: #23262e; padding: 0 3px; border-radius: 3px; }
  .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  button { background: #23262e; color: #e6e6e6; border: 1px solid #383c46; border-radius: 5px; padding: 6px 14px; font-size: 12px; cursor: pointer; }
  button:hover { border-color: #d9a441; }
  button:disabled { opacity: 0.5; cursor: default; }
  .primary { background: #2c4a75; }
</style>
