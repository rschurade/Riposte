<script lang="ts">
  import { ed } from './state.svelte.ts';

  let outDir = $state('');
  let busy = $state(false);
  let expMode = $state<'external' | 'baked' | 'spx' | 'ograf'>('external');
  let ografAssets = $state<'shared' | 'bundled'>('shared');

  // SPX field configuration
  interface SpxFieldRow {
    field: string;
    ftype: string;
    title: string;
    value: string;
  }
  let spxFields: SpxFieldRow[] = $state([]);
  let showSpxFields = $state(false);

  const SPX_FTYPES = ['textfield', 'textarea', 'number', 'filelist', 'dropdown', 'instruction', 'hidden'];

  // Seed the form when the dialog opens. Must NOT read expMode — reading it
  // would make this effect depend on it, and every dropdown change would
  // re-fire this effect and reset the user's selection back to the saved mode.
  // The remembered target dir is PER SET (server-side riposte.config.json —
  // a global key would leak one set's target into every other set's export).
  $effect(() => {
    if (!ed.exportDialogOpen) return;
    outDir = '';
    busy = false;
    expMode = ed.setRef?.export?.mode ?? 'external';
    ografAssets = ed.setRef?.export?.ografAssets ?? 'shared';
    const dirKey = `${ed.setRef?.root}/${ed.setRef?.name}`;
    void fetch('/api/config')
      .then((r) => r.json())
      .then((cfg: { exportDirs?: Record<string, string> }) => {
        if (ed.exportDialogOpen && cfg.exportDirs?.[dirKey]) outDir = cfg.exportDirs[dirKey];
      })
      .catch(() => {});
  });

  // React to mode dropdown changes (fires for the initial seed too).
  $effect(() => {
    if (!ed.exportDialogOpen) return;
    loadSpxFields(expMode);
  });

  function loadSpxFields(mode: string): void {
    if (mode === 'spx') {
      showSpxFields = true;
      const saved = ed.loadSpxFields();
      const keys = ed.getSceneKeys();
      const savedByField = new Map(saved.map((f) => [f.field, f]));
      spxFields = keys.map((k) => {
        const existing = savedByField.get(k.field);
        return existing ?? {
          field: k.field,
          ftype: k.ftype ?? 'textfield',
          title: k.title ?? k.field.replace(/^_/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
          value: k.value,
        };
      });
    } else {
      showSpxFields = false;
      spxFields = [];
    }
  }

  async function doExport(): Promise<void> {
    if (busy) return;
    busy = true;
    // Mode and layout here are PER-EXPORT overrides — never written back to
    // the set. Trying an OGraf export must not silently rewrite the set's
    // on-air settings; Set Options is where the default is changed deliberately.
    // Empty target = the classic workflow: <set-dir>/export (server default);
    // Deploy remains the way changes reach the CasparCG template dir.
    if (showSpxFields) ed.saveSpxFields(spxFields);
    await ed.exportSet({
      outDir: outDir.trim() || undefined,
      mode: expMode,
      ografAssets: expMode === 'ograf' ? ografAssets : undefined,
      spxFields: showSpxFields ? spxFields : undefined,
    });
  }

  function resetSpxFields(): void {
    const keys = ed.getSceneKeys();
    spxFields = keys.map((k) => ({
      field: k.field,
      ftype: k.ftype ?? 'textfield',
      title: k.title ?? k.field.replace(/^_/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      value: k.value,
    }));
  }

  function moveField(index: number, dir: 'up' | 'down'): void {
    const target = dir === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= spxFields.length) return;
    const row = spxFields[index]!;
    spxFields[index] = spxFields[target]!;
    spxFields[target] = row;
    spxFields = [...spxFields]; // trigger reactivity
  }

  function onKey(ev: KeyboardEvent): void {
    if (!ed.exportDialogOpen) return;
    if (ev.key === 'Escape') ed.exportDialogOpen = false;
    if (ev.key === 'Enter') void doExport();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if ed.exportDialogOpen && ed.setRef}
  <div class="overlay" role="presentation" onclick={() => (ed.exportDialogOpen = false)}>
    <div class="dialog" role="dialog" aria-label="Export set" onclick={(ev) => ev.stopPropagation()}>
      <h2>{ed.setRef.name} <span class="dim">export</span></h2>
      <p class="meta">
        <label for="ed-mode" title="This export only — the set's saved mode (Set Options) is not changed">Mode</label>
        <select id="ed-mode" bind:value={expMode}>
          <option value="external">external — shells + shared assets (default)</option>
          <option value="baked">baked — single-file HTML (compat)</option>
          <option value="spx">SPX — external + SPXGCTemplateDefinition</option>
          <option value="ograf">OGraf — manifest + graphic.mjs (EBU standard)</option>
        </select>
        {#if expMode === 'ograf'}
          <label for="ed-ograf-assets">Assets</label>
          <select id="ed-ograf-assets" bind:value={ografAssets}>
            <option value="shared">shared — one assets/ folder for the whole set</option>
            <option value="bundled">bundled — every graphic folder self-contained</option>
          </select>
        {/if}
      </p>

      <label class="lbl" for="ed-target">Target directory <span class="dim">— optional; empty = the set's own export/ folder</span></label>
      <input
        id="ed-target"
        type="text"
        bind:value={outDir}
        placeholder="<set>/export (use Deploy to reach the CasparCG template dir)"
        spellcheck="false"
        disabled={busy}
      />

      {#if showSpxFields}
        <div class="spx-section">
          <div class="spx-header">
            <span>SPX DataFields — <b>{ed.sceneFile?.split('/').pop()?.replace(/\.json$/i, '') ?? '?'}</b> only (other scenes auto-detect)</span>
            <button class="sm" onclick={resetSpxFields} disabled={busy}>auto-detect</button>
          </div>
          <div class="spx-table">
            <div class="spx-row head">
              <span></span>
              <span>Field</span>
              <span>Ftype</span>
              <span>Title</span>
              <span>Value</span>
            </div>
            {#each spxFields as f, i (f.field)}
              <div class="spx-row">
                <span class="reorder">
                  <button class="arr" title="Move up" disabled={i === 0 || busy} onclick={() => moveField(i, 'up')}>▲</button>
                  <button class="arr" title="Move down" disabled={i === spxFields.length - 1 || busy} onclick={() => moveField(i, 'down')}>▼</button>
                </span>
                <span class="field-name">{f.field}</span>
                <select bind:value={spxFields[i]!.ftype} disabled={busy}>
                  {#each SPX_FTYPES as t}
                    <option value={t}>{t}</option>
                  {/each}
                </select>
                <input type="text" bind:value={spxFields[i]!.title} spellcheck="false" disabled={busy} />
                <input type="text" bind:value={spxFields[i]!.value} spellcheck="false" disabled={busy} />
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <p class="hint">
        {#if expMode === 'external'}
          Writes HTML shells + shared assets folder. Only changed files are updated.
          {:else if expMode === 'spx'}
          Each HTML shell carries an embedded SPXGCTemplateDefinition.
          The DataFields above apply to the open scene; every other scene's
          fields are auto-detected from its data-binding keys.
          {:else if expMode === 'ograf'}
          {#if ografAssets === 'shared'}
            One thin folder per scene (manifest + graphic.mjs) sharing a single
            assets/ folder — deploy the export dir as a whole. WebP re-encoding applies.
          {:else}
            Every graphic folder carries its own riposte.js + assets — a single
            folder can be handed to any OGraf host, at the cost of duplicating
            assets per scene.
          {/if}
          For OGraf hosts (SPX, Sofie, …) — on-air CasparCG output stays
          external mode + Deploy.
        {:else}
          Writes self-contained single-file HTML per scene.
        {/if}
      </p>

      <div class="row">
        <button class="primary" onclick={doExport} disabled={busy}>
          {busy ? '…' : 'Export'}
        </button>
        <button onclick={() => (ed.exportDialogOpen = false)} disabled={busy}>Cancel</button>
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
    width: 620px;
    max-width: 92vw;
    max-height: 85vh;
    overflow-y: auto;
    color: #e6e6e6;
  }
  h2 { margin: 0 0 2px; font-size: 15px; }
  .dim { color: #8a8f98; font-weight: 400; font-size: 12px; }
  .meta { color: #8a8f98; font-size: 11px; margin: 0 0 14px; }
  .meta label { margin-right: 6px; }
  .meta select {
    background: #23262e;
    color: #e6e6e6;
    border: 1px solid #383c46;
    border-radius: 5px;
    padding: 4px 6px;
    font-size: 12px;
  }
  .lbl { display: block; font-size: 12px; color: #aab; margin-bottom: 4px; }
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
  .spx-section { margin-top: 14px; border-top: 1px solid #383c46; padding-top: 12px; }
  .spx-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 12px; color: #aab; }
  .spx-table { display: flex; flex-direction: column; gap: 4px; }
  .spx-row { display: grid; grid-template-columns: 28px 90px 100px 1fr 1fr; gap: 4px; align-items: center; }
  .spx-row.head { font-size: 10px; color: #8a8f98; text-transform: uppercase; }
  .spx-row select, .spx-row input {
    background: #23262e;
    color: #e6e6e6;
    border: 1px solid #383c46;
    border-radius: 4px;
    padding: 4px 6px;
    font-size: 12px;
  }
  .field-name { font-size: 12px; color: #8a8f98; }
  .reorder { display: flex; flex-direction: column; gap: 1px; }
  .arr { padding: 0 2px; font-size: 8px; line-height: 1; background: none; border: none; color: #5a5f68; cursor: pointer; }
  .arr:hover { color: #d9a441; }
  .arr:disabled { opacity: 0.3; cursor: default; }
  .hint { font-size: 11px; color: #8a8f98; line-height: 1.5; margin: 12px 0 0; }
  .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  button { background: #23262e; color: #e6e6e6; border: 1px solid #383c46; border-radius: 5px; padding: 6px 14px; font-size: 12px; cursor: pointer; }
  button:hover { border-color: #d9a441; }
  button:disabled { opacity: 0.5; cursor: default; }
  .primary { background: #2c4a75; }
  .sm { padding: 3px 10px; font-size: 11px; }
</style>
