<script lang="ts">
  import { ed } from './state.svelte.ts';

  let outDir = $state('');
  let busy = $state(false);

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

  $effect(() => {
    if (!ed.exportDialogOpen) return;
    outDir = localStorage.getItem('riposte.exportDir') ?? '';
    busy = false;
    // Load SPX fields when mode is SPX
    if ((ed.setRef?.export?.mode ?? 'external') === 'spx') {
      showSpxFields = true;
      const saved = ed.loadSpxFields();
      const keys = ed.getSceneKeys();
      // Merge saved fields with scene keys (add new keys, keep saved config)
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
  });

  async function doExport(): Promise<void> {
    if (!outDir.trim() || busy) return;
    busy = true;
    if (showSpxFields) {
      ed.saveSpxFields(spxFields);
      await ed.exportSet(outDir.trim(), spxFields);
    } else {
      await ed.exportSet(outDir.trim());
    }
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
        Mode: <strong>{ed.setRef.export?.mode ?? 'external'}</strong>
        {#if (ed.setRef.export?.mode ?? 'external') === 'spx'}
          &mdash; CasparCG HTML shells with SPX template definition
        {/if}
        {#if (ed.setRef.export?.mode ?? 'external') === 'ograf'}
          &mdash; OGraf manifest + graphic.mjs (EBU standard)
        {/if}
      </p>

      <label class="lbl" for="ed-target">Target directory</label>
      <input
        id="ed-target"
        type="text"
        bind:value={outDir}
        placeholder="e.g. C:\CasparCG\template\MySet"
        spellcheck="false"
        disabled={busy}
      />

      {#if showSpxFields}
        <div class="spx-section">
          <div class="spx-header">
            <span>SPX DataFields</span>
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
        {#if (ed.setRef.export?.mode ?? 'external') === 'external'}
          Writes HTML shells + shared assets folder. Only changed files are updated.
        {:else if (ed.setRef.export?.mode ?? 'external') === 'spx'}
          Each HTML shell carries an embedded SPXGCTemplateDefinition.
          Configure DataFields above to control what SPX shows in its controller UI.
        {:else if (ed.setRef.export?.mode ?? 'external') === 'ograf'}
          Generates OGraf graphic: manifest + graphic.mjs + riposte.js + assets.
        {:else}
          Writes self-contained single-file HTML per scene.
        {/if}
      </p>

      <div class="row">
        <button class="primary" onclick={doExport} disabled={!outDir.trim() || busy}>
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
  .meta strong { color: #d9a441; }
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
