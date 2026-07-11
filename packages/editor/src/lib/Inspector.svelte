<script lang="ts">
  import type { StyleProperty, VisibilityBinding } from '@riposte/shared';
  import { ed, layerLabel, propNumber } from './state.svelte.ts';

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
    // animated: upsert a keyframe at the playhead; static: set the value
    ed.setValueAtPlayhead('el', prop, v);
  }

  function hasKfAtPlayhead(prop: string): boolean {
    return !!el?.style[prop]?.keyframes?.some((k) => k.frame === ed.frame);
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

  const EASING_PRESETS: Record<string, { p1x: number; p1y: number; p2x: number; p2y: number } | null> = {
    linear: null,
    ease: { p1x: 0.25, p1y: 0.1, p2x: 0.25, p2y: 1 },
    'ease-in': { p1x: 0.42, p1y: 0, p2x: 1, p2y: 1 },
    'ease-out': { p1x: 0, p1y: 0, p2x: 0.58, p2y: 1 },
    'ease-in-out': { p1x: 0.42, p1y: 0, p2x: 0.58, p2y: 1 },
  };

  function easingName(e: { p1x: number; p1y: number; p2x: number; p2y: number } | undefined): string {
    if (!e) return 'linear';
    for (const [name, preset] of Object.entries(EASING_PRESETS)) {
      if (preset && preset.p1x === e.p1x && preset.p1y === e.p1y && preset.p2x === e.p2x && preset.p2y === e.p2y) {
        return name;
      }
    }
    return 'custom';
  }

  /** 'hide' = hideWhen (default ["0"]), 'show' = showWhen whitelist. */
  function visMode(v: VisibilityBinding | undefined): 'hide' | 'show' {
    return v?.showWhen ? 'show' : 'hide';
  }

  function visValues(v: VisibilityBinding | undefined): string {
    return (v?.showWhen ?? v?.hideWhen ?? ['0']).join(', ');
  }

  function parseValues(raw: string): string[] {
    return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  }

  /** Rebuild the whole binding from the four inputs; empty bind key removes it. */
  function setVisibility(patch: Partial<{ bindKey: string; mode: 'hide' | 'show'; values: string; initial: string }>): void {
    if (!layer) return;
    const id = layer.id;
    const cur = el?.visibility;
    const bindKey = patch.bindKey ?? cur?.bindKey ?? '';
    const mode = patch.mode ?? visMode(cur);
    const values = parseValues(patch.values ?? visValues(cur));
    const initial = patch.initial ?? cur?.initial ?? 'visible';
    ed.mutate('set visibility binding', (scene) => {
      const l = scene.composition.layers.find((x) => x.id === id);
      if (!l) return;
      if (!bindKey) {
        delete l.element.visibility;
        return;
      }
      const b: VisibilityBinding = { bindKey };
      if (mode === 'show') b.showWhen = values;
      else if (values.length > 0 && !(values.length === 1 && values[0] === '0')) b.hideWhen = values; // ["0"] is the default
      if (initial === 'hidden') b.initial = 'hidden';
      l.element.visibility = b;
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
    <h2>{layerLabel(layer)}</h2>
    <p class="type">{el.type}</p>

    <div class="grid three">
      {#each NUM_PROPS as np (np.prop)}
        {#if el.style[np.prop] || ['x', 'y'].includes(np.prop)}
          <label for="in-{np.prop}">{np.label}</label>
          <input
            id="in-{np.prop}"
            type="number"
            step="1"
            value={numAt(el.style[np.prop], np.fallback)}
            onchange={(e) => setStyleNumber(np.prop, (e.currentTarget as HTMLInputElement).value)}
          />
          <button
            class="kfbtn"
            class:on={hasKfAtPlayhead(np.prop)}
            class:animated={isAnimated(el.style[np.prop])}
            title={hasKfAtPlayhead(np.prop) ? 'Remove keyframe at playhead' : 'Add keyframe at playhead'}
            onclick={() => ed.toggleKeyframe('el', np.prop)}
          >◆</button>
        {/if}
      {/each}
    </div>
    <div class="grid">
      <label for="in-key">Key</label>
      <input
        id="in-key"
        type="text"
        value={el.key ?? ''}
        onchange={(e) => ed.setElementKey(layer.id, (e.currentTarget as HTMLInputElement).value)}
      />
    </div>

    <h3>Visibility <span class="dim">show/hide by update() key</span></h3>
    <div class="grid">
      <label for="vis-key">Bind key</label>
      <input
        id="vis-key"
        type="text"
        placeholder="e.g. _greenSwitch"
        value={el.visibility?.bindKey ?? ''}
        onchange={(e) => setVisibility({ bindKey: (e.currentTarget as HTMLInputElement).value.trim() })}
      />
      {#if el.visibility}
        <label for="vis-mode">Mode</label>
        <select
          id="vis-mode"
          value={visMode(el.visibility)}
          onchange={(e) => setVisibility({ mode: (e.currentTarget as HTMLSelectElement).value as 'hide' | 'show' })}
        >
          <option value="hide">hidden when value is…</option>
          <option value="show">visible only when value is…</option>
        </select>
        <label for="vis-values">Values</label>
        <input
          id="vis-values"
          type="text"
          placeholder="0"
          value={visValues(el.visibility)}
          onchange={(e) => setVisibility({ values: (e.currentTarget as HTMLInputElement).value })}
        />
        <label for="vis-initial">Initial</label>
        <select
          id="vis-initial"
          value={el.visibility.initial ?? 'visible'}
          onchange={(e) => setVisibility({ initial: (e.currentTarget as HTMLSelectElement).value })}
        >
          <option value="visible">visible</option>
          <option value="hidden">hidden</option>
        </select>
      {/if}
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
        <select
          id="in-font"
          value={el.fontFamily ?? ''}
          onchange={(e) => setElementField('fontFamily', (e.currentTarget as HTMLSelectElement).value || undefined)}
        >
          {#if el.fontFamily && !(ed.setRef?.fonts ?? []).some((f) => f.family === el.fontFamily)}
            <option value={el.fontFamily}>{el.fontFamily} (missing)</option>
          {/if}
          <option value="">(default)</option>
          {#each ed.setRef?.fonts ?? [] as f (f.family)}
            <option value={f.family}>{f.family}</option>
          {/each}
        </select>
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

    {#if ed.selectedKf}
      {@const sel = ed.selectedKf}
      {@const kfStyle = layer ? (sel.targetKey === 'el' ? layer.element.style : layer.masks?.[Number(sel.targetKey.slice(4))]?.style) : null}
      {@const kf = kfStyle?.[sel.prop]?.keyframes?.find((k) => k.frame === sel.frame)}
      <h3>Keyframe · {sel.prop} @{sel.frame}</h3>
      {#if kf}
        <div class="grid">
          <label for="kf-frame">Frame</label>
          <input id="kf-frame" type="number" value={sel.frame}
            onchange={(e) => ed.setKeyframeNumber('frame', Number((e.currentTarget as HTMLInputElement).value))} />
          <label for="kf-value">Value</label>
          <input id="kf-value" type="number" step="any" value={typeof kf.value === 'number' ? kf.value : 0}
            onchange={(e) => ed.setKeyframeNumber('value', Number((e.currentTarget as HTMLInputElement).value))} />
          <label for="kf-ease">Easing</label>
          <select id="kf-ease" value={easingName(kf.easing)}
            onchange={(e) => ed.setKeyframeEasing(EASING_PRESETS[(e.currentTarget as HTMLSelectElement).value] ?? null)}>
            {#each Object.keys(EASING_PRESETS) as name (name)}
              <option value={name}>{name}</option>
            {/each}
            {#if easingName(kf.easing) === 'custom'}<option value="custom">custom</option>{/if}
          </select>
        </div>
        <button class="minor" onclick={() => ed.deleteSelectedKeyframe()}>Delete keyframe (Del)</button>
      {/if}
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
    <p class="hint">
      ◆ dim = property animated · gold = keyframe at playhead. Number edits on
      animated properties write a keyframe at the playhead. Stage drags move the
      whole curve (and masks). Select diamonds in the timeline to retime or ease.
    </p>
  {:else if ed.scene}
    {@const comp = ed.scene.composition}
    <h2>{ed.scene.name}</h2>
    <p class="type">scene · {comp.layers.length} layers</p>

    <h3>Composition</h3>
    <div class="grid">
      <label for="sc-size">Size</label>
      <span class="ro">{comp.width} × {comp.height}</span>
      <label for="sc-fps">FPS</label>
      <input id="sc-fps" type="number" value={comp.fps}
        onchange={(e) => ed.setCompositionNumber('fps', Number((e.currentTarget as HTMLInputElement).value))} />
      <label for="sc-dur">Duration</label>
      <input id="sc-dur" type="number" value={comp.duration}
        onchange={(e) => ed.setCompositionNumber('duration', Number((e.currentTarget as HTMLInputElement).value))} />
    </div>

    <h3>Markers</h3>
    {#each comp.markers as m, i (i)}
      <div class="marker-row">
        <span class="mtype {m.type}">{m.type}</span>
        <input type="number" value={m.frame}
          onchange={(e) => ed.updateMarker(i, { frame: Number((e.currentTarget as HTMLInputElement).value) })} />
        <button class="remove" title="Remove marker" onclick={() => ed.removeMarker(i)}>✕</button>
      </div>
      {#if m.type === 'action'}
        <textarea class="code small" rows="3" spellcheck="false" value={m.source}
          onchange={(e) => ed.updateMarker(i, { source: (e.currentTarget as HTMLTextAreaElement).value })}
        ></textarea>
      {/if}
    {/each}
    <div class="row3">
      <button class="minor" onclick={() => ed.addMarker('pause')}>+ pause @{ed.frame}</button>
      <button class="minor" onclick={() => ed.addMarker('outro')}>+ outro @{ed.frame}</button>
      <button class="minor" onclick={() => ed.addMarker('action')}>+ action @{ed.frame}</button>
    </div>

    <h3>Composition action <span class="dim">runs once at load</span></h3>
    <textarea class="code" rows="14" spellcheck="false" value={comp.action ?? ''}
      placeholder={'// custom code, e.g.\n// useOnUpdate("_key", (key, value, next) => {\n//   find("_row1").hide();\n//   next();\n// });'}
      onchange={(e) => ed.setCompositionAction((e.currentTarget as HTMLTextAreaElement).value)}
    ></textarea>
    <p class="hint">
      Scripts run in the bench and on air (not in the editor preview). Plain
      show/hide belongs in an element's Visibility binding, not here. API:
      useOnPlay/useOnUpdate/useOnStop/useOnNext/useOnInvoke, find(key) →
      element (setContent, show/hide, node), riposte = runtime, this =
      composition (play, pause, goTo…). Frame-action markers run when the
      playhead crosses their frame.
    </p>
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
  .grid.three { grid-template-columns: 62px 1fr 22px; margin-bottom: 6px; }
  .kfbtn {
    background: none;
    border: none;
    color: #4a4e58;
    cursor: pointer;
    font-size: 13px;
    padding: 0;
  }
  .kfbtn.animated { color: #8a6a2a; }
  .kfbtn.on { color: #d9a441; }
  .kfbtn:hover { color: #d9a441; }
  .minor {
    margin-top: 6px;
    background: #23262e;
    border: 1px solid #383c46;
    color: #cfd3da;
    border-radius: 4px;
    padding: 3px 10px;
    cursor: pointer;
    font-size: 11px;
  }
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
  .ro { font-size: 12px; color: #aab; }
  .dim { color: #676c76; font-size: 10px; text-transform: none; letter-spacing: 0; }
  .code {
    font: 11px/1.5 Consolas, monospace;
    width: 100%;
    background: #14161b;
    color: #cfe0b8;
    border: 1px solid #383c46;
    border-radius: 4px;
    padding: 6px;
    white-space: pre;
  }
  .code.small { margin: 2px 0 6px; }
  .marker-row { display: flex; gap: 6px; align-items: center; margin-bottom: 4px; }
  .marker-row input { width: 70px; }
  .marker-row .remove { background: none; border: none; color: #a55; cursor: pointer; }
  .mtype { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; width: 52px; }
  .mtype.pause { color: #4ea1e0; }
  .mtype.outro { color: #e05555; }
  .mtype.action { color: #8a62d0; }
  .row3 { display: flex; gap: 4px; margin-top: 4px; }
  .hint { color: #676c76; font-size: 11px; margin-top: 16px; }
  .empty { color: #676c76; text-align: center; margin-top: 40px; }
</style>
