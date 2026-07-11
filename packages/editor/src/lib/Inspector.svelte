<script lang="ts">
  import type { StyleProperty } from '@riposte/shared';
  import { ed, propNumber } from './state.svelte.ts';

  const layer = $derived(ed.selectedLayer);
  const el = $derived(layer?.element ?? null);

  function isAnimated(p: StyleProperty | undefined): boolean {
    return (p?.keyframes?.length ?? 0) > 0;
  }

  /** Current numeric value for display (animated props show value at playhead). */
  function numAt(p: StyleProperty | undefined, fallback: number): number {
    return Math.round(propNumber(p, ed.frame, fallback) * 100) / 100;
  }

  function setStyleNumber(prop: string, raw: string): void {
    const v = Number(raw);
    if (!Number.isFinite(v) || !layer) return;
    const id = layer.id;
    ed.mutate(`set ${prop}`, (scene) => {
      const l = scene.composition.layers.find((x) => x.id === id);
      if (!l) return;
      const p = l.element.style[prop];
      if (p && p.keyframes?.length) {
        // animated: shift all keyframes so the value at the playhead matches
        const cur = propNumber(p, ed.frame, 0);
        const delta = v - cur;
        if (typeof p.value === 'number') p.value += delta;
        for (const k of p.keyframes) if (typeof k.value === 'number') k.value += delta;
      } else if (p) {
        p.value = v;
      } else {
        l.element.style[prop] = { value: v };
      }
    });
  }

  function setElementField(field: string, value: unknown): void {
    if (!layer) return;
    const id = layer.id;
    ed.mutate(`set ${field}`, (scene) => {
      const l = scene.composition.layers.find((x) => x.id === id);
      if (l) (l.element as unknown as Record<string, unknown>)[field] = value;
    });
  }

  function setLayerField(field: 'hidden' | 'isGuide', value: boolean): void {
    if (!layer) return;
    const id = layer.id;
    ed.mutate(`set ${field}`, (scene) => {
      const l = scene.composition.layers.find((x) => x.id === id);
      if (l) l[field] = value || undefined;
    });
  }

  const NUM_PROPS: { prop: string; label: string; fallback: number }[] = [
    { prop: 'x', label: 'X', fallback: 0 },
    { prop: 'y', label: 'Y', fallback: 0 },
    { prop: 'width', label: 'W', fallback: 0 },
    { prop: 'height', label: 'H', fallback: 0 },
    { prop: 'rotation', label: 'Rot', fallback: 0 },
    { prop: 'opacity', label: 'Opacity', fallback: 1 },
    { prop: 'fontSize', label: 'Font size', fallback: 24 },
  ];
</script>

<aside>
  {#if layer && el}
    <h2>{layer.name}</h2>
    <p class="type">{el.type}{el.key ? ` · ${el.key}` : ''}</p>

    <div class="grid">
      {#each NUM_PROPS as np (np.prop)}
        {#if el.style[np.prop] || ['x', 'y'].includes(np.prop)}
          <label for="in-{np.prop}">{np.label}{isAnimated(el.style[np.prop]) ? ' ◆' : ''}</label>
          <input
            id="in-{np.prop}"
            type="number"
            step="1"
            value={numAt(el.style[np.prop], np.fallback)}
            onchange={(e) => setStyleNumber(np.prop, (e.currentTarget as HTMLInputElement).value)}
          />
        {/if}
      {/each}

      <label for="in-key">Key</label>
      <input
        id="in-key"
        type="text"
        value={el.key ?? ''}
        onchange={(e) => setElementField('key', (e.currentTarget as HTMLInputElement).value || undefined)}
      />
    </div>

    {#if el.type === 'text'}
      <h3>Text</h3>
      <textarea
        rows="2"
        value={el.content}
        onchange={(e) => setElementField('content', (e.currentTarget as HTMLTextAreaElement).value)}
      ></textarea>
      <div class="grid">
        <label for="in-font">Font</label>
        <input
          id="in-font"
          type="text"
          value={el.fontFamily ?? ''}
          onchange={(e) => setElementField('fontFamily', (e.currentTarget as HTMLInputElement).value)}
        />
        <label for="in-align">Align</label>
        <select
          id="in-align"
          value={el.textAlign ?? 'center'}
          onchange={(e) => setElementField('textAlign', (e.currentTarget as HTMLSelectElement).value)}
        >
          <option value="left">left</option>
          <option value="center">center</option>
          <option value="right">right</option>
        </select>
        <label for="in-squeeze">Squeeze</label>
        <input
          id="in-squeeze"
          type="checkbox"
          checked={el.autoSqueeze ?? false}
          onchange={(e) => setElementField('autoSqueeze', (e.currentTarget as HTMLInputElement).checked || undefined)}
        />
      </div>
    {/if}

    {#if el.type === 'imageLoader'}
      <h3>Image loader</h3>
      <div class="grid">
        <label for="in-fit">Fit</label>
        <select
          id="in-fit"
          value={el.fit}
          onchange={(e) => setElementField('fit', (e.currentTarget as HTMLSelectElement).value)}
        >
          {#each ['original', 'contain', 'cover', 'stretch', 'fitWidth', 'fitHeight'] as f (f)}
            <option value={f}>{f}</option>
          {/each}
        </select>
      </div>
    {/if}

    {#if el.type === 'image'}
      <h3>Image</h3>
      <p class="asset">{el.asset}</p>
    {/if}

    <h3>Layer</h3>
    <div class="grid">
      <label for="in-hidden">Hidden</label>
      <input id="in-hidden" type="checkbox" checked={layer.hidden ?? false}
        onchange={(e) => setLayerField('hidden', (e.currentTarget as HTMLInputElement).checked)} />
      <label for="in-guide">Guide</label>
      <input id="in-guide" type="checkbox" checked={layer.isGuide ?? false}
        onchange={(e) => setLayerField('isGuide', (e.currentTarget as HTMLInputElement).checked)} />
    </div>
    <p class="hint">◆ = animated: edits shift the whole curve. Masks move with the element on drag.</p>
  {:else}
    <p class="empty">Nothing selected</p>
  {/if}
</aside>

<style>
  aside {
    border-left: 1px solid #2c2f38;
    padding: 10px;
    overflow-y: auto;
    font-size: 13px;
    min-height: 0;
  }
  h2 { font-size: 13px; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: #8a8f98;
    margin: 14px 0 6px;
  }
  .type { color: #676c76; font-size: 11px; margin: 2px 0 10px; }
  .grid { display: grid; grid-template-columns: 70px 1fr; gap: 5px 8px; align-items: center; }
  label { color: #aab; font-size: 12px; }
  input, select, textarea {
    background: #23262e;
    color: #e6e6e6;
    border: 1px solid #383c46;
    border-radius: 4px;
    padding: 3px 7px;
    font-size: 12px;
    width: 100%;
  }
  input[type='checkbox'] { width: auto; justify-self: start; }
  textarea { margin-bottom: 6px; font-family: inherit; }
  .asset { font: 11px Consolas, monospace; color: #aab; word-break: break-all; }
  .hint { color: #676c76; font-size: 11px; margin-top: 16px; }
  .empty { color: #676c76; text-align: center; margin-top: 40px; }
</style>
