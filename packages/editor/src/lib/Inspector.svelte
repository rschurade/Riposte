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

  function setStyleNumber(prop: string, raw: string, pct?: boolean): void {
    let v = Number(raw);
    if (!Number.isFinite(v) || !layer) return;
    if (pct) v /= 100;
    // animated: upsert a keyframe at the playhead; static: set the value
    ed.setValueAtPlayhead('el', prop, v);
  }

  /** Display value: percent-style props (scale, opacity, filters) show ×100. */
  function dispAt(p: StyleProperty | undefined, def: PropDef): number {
    const v = propNumber(p, ed.frame, def.fallback) * (def.pct ? 100 : 1);
    return Math.round(v * 100) / 100;
  }

  function hasKfAtPlayhead(prop: string): boolean {
    return !!el?.style[prop]?.keyframes?.some((k) => k.frame === ed.frame);
  }

  function maskHasKfAtPlayhead(mi: number, prop: string): boolean {
    return !!layer?.masks?.[mi]?.style[prop]?.keyframes?.some((k) => k.frame === ed.frame);
  }

  function setMaskNumber(mi: number, prop: string, raw: string): void {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    ed.setValueAtPlayhead(`mask${mi}`, prop, v);
  }

  const MASK_PROPS: { prop: string; label: string; fallback: number }[] = [
    { prop: 'x', label: 'X', fallback: 0 },
    { prop: 'y', label: 'Y', fallback: 0 },
    { prop: 'width', label: 'W', fallback: 0 },
    { prop: 'height', label: 'H', fallback: 0 },
  ];

  /** Current color-style value ('' when unset). */
  function colorAt(prop: string): string {
    const p = el?.style[prop];
    return p && typeof p.value === 'string' ? p.value : '';
  }

  /** Set/clear a color style property (any CSS color string; empty clears). */
  function setStyleColor(prop: string, raw: string): void {
    if (!layer) return;
    const id = layer.id;
    const value = raw.trim();
    ed.mutate(`set ${prop}`, (scene) => {
      const l = scene.composition.layers.find((x) => x.id === id);
      if (!l) return;
      if (!value) delete l.element.style[prop];
      else l.element.style[prop] = { value, unit: 'color' };
    });
  }

  const PAD_LABELS = ['top', 'right', 'bottom', 'left'] as const;

  function setPadding(index: number, raw: string): void {
    if (!layer || el?.type !== 'text') return;
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    const pads = [...(el.padding ?? [0, 0, 0, 0])] as [number, number, number, number];
    pads[index] = v;
    setElementField('padding', pads.every((p) => p === 0) ? undefined : pads);
  }

  const TEXT_STYLE_PROPS: PropDef[] = [
    { prop: 'lineHeight', label: 'Line height', fallback: 1.2 },
    { prop: 'letterSpacing', label: 'Letter spacing', fallback: 0 },
  ];

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

  interface PropDef {
    prop: string;
    label: string;
    fallback: number;
    /** stored 0–1 / ×1, shown as % */
    pct?: boolean;
  }

  const TRANSFORM_PROPS: PropDef[] = [
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

  const FILTER_DEFS: PropDef[] = [
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

  let filtersOpen = $state(false);
  /** auto-open the Filter group when the element actually uses filters */
  const hasFilterData = $derived(!!el && FILTER_DEFS.some((d) => el.style[d.prop]));
</script>

<aside>
  {#if layer && el}
    <h2>{layerLabel(layer)}</h2>
    <p class="type">{el.type}</p>

    {#snippet propRow(np: PropDef)}
      <label for="in-{np.prop}">{np.label}</label>
      <input
        id="in-{np.prop}"
        type="number"
        step="1"
        value={dispAt(el!.style[np.prop], np)}
        onchange={(e) => setStyleNumber(np.prop, (e.currentTarget as HTMLInputElement).value, np.pct)}
      />
      <button
        class="kfbtn"
        class:on={hasKfAtPlayhead(np.prop)}
        class:animated={isAnimated(el!.style[np.prop])}
        title={hasKfAtPlayhead(np.prop)
          ? `Remove ${np.label} keyframe @${ed.frame}`
          : `Add ${np.label} keyframe @${ed.frame}`}
        onclick={() => ed.toggleKeyframe('el', np.prop, np.fallback)}
      >◆</button>
    {/snippet}

    <h3>Transform</h3>
    <div class="grid three">
      {#each TRANSFORM_PROPS as np (np.prop)}
        {#if np.prop !== 'fontSize' || el.type === 'text'}
          {@render propRow(np)}
        {/if}
      {/each}
    </div>

    <h3>
      <button class="linkish" onclick={() => (filtersOpen = !filtersOpen)}>
        {filtersOpen || hasFilterData ? '▾' : '▸'} Filter
        {#if hasFilterData}<span class="dim">in use</span>{/if}
      </button>
    </h3>
    {#if filtersOpen || hasFilterData}
      <div class="grid three">
        {#each FILTER_DEFS as np (np.prop)}
          {@render propRow(np)}
        {/each}
      </div>
    {/if}
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

    {#each layer.masks ?? [] as mask, mi (mask.id)}
      <h3>Mask{(layer.masks?.length ?? 0) > 1 ? ` ${mi + 1}` : ''} <span class="dim">{mask.type} · clips this element</span></h3>
      {#if mask.type === 'path'}
        <p class="hint">Path mask — geometry not editable yet.</p>
      {:else}
        <div class="grid three">
          {#each MASK_PROPS as np (np.prop)}
            <label for="mask{mi}-{np.prop}">{np.label}</label>
            <input
              id="mask{mi}-{np.prop}"
              type="number"
              step="1"
              value={numAt(mask.style[np.prop], np.fallback)}
              onchange={(e) => setMaskNumber(mi, np.prop, (e.currentTarget as HTMLInputElement).value)}
            />
            <button
              class="kfbtn"
              class:on={maskHasKfAtPlayhead(mi, np.prop)}
              class:animated={isAnimated(mask.style[np.prop])}
              title={maskHasKfAtPlayhead(mi, np.prop)
                ? `Remove mask ${np.label} keyframe @${ed.frame}`
                : `Add mask ${np.label} keyframe @${ed.frame}`}
              onclick={() => ed.toggleKeyframe(`mask${mi}`, np.prop, np.fallback)}
            >◆</button>
          {/each}
        </div>
      {/if}
    {/each}

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
        <label for="in-valign">V-Align</label>
        <select
          id="in-valign"
          value={el.verticalAlign ?? 'middle'}
          onchange={(e) => setElementField('verticalAlign', (e.currentTarget as HTMLSelectElement).value)}
        >
          <option value="top">top</option>
          <option value="middle">middle</option>
          <option value="bottom">bottom</option>
        </select>
        <label for="in-squeeze">Squeeze</label>
        <input
          id="in-squeeze"
          type="checkbox"
          checked={el.autoSqueeze ?? false}
          onchange={(e) => setElementField('autoSqueeze', (e.currentTarget as HTMLInputElement).checked || undefined)}
        />
        <label for="in-wrap">Wrap</label>
        <input
          id="in-wrap"
          type="checkbox"
          checked={el.multiline ?? false}
          onchange={(e) => setElementField('multiline', (e.currentTarget as HTMLInputElement).checked || undefined)}
        />
        <label for="in-transform">Case</label>
        <select
          id="in-transform"
          value={el.textTransform ?? 'none'}
          onchange={(e) => {
            const v = (e.currentTarget as HTMLSelectElement).value;
            setElementField('textTransform', v === 'none' ? undefined : v);
          }}
        >
          <option value="none">none</option>
          <option value="uppercase">UPPERCASE</option>
          <option value="lowercase">lowercase</option>
          <option value="capitalize">Capitalize</option>
        </select>
        <label for="in-color">Color</label>
        <span class="colorrow">
          <span class="swatch"><span class="swatchfill" style="background-color:{colorAt('color') || '#fff'}"></span></span>
          <input
            id="in-color"
            type="text"
            placeholder="e.g. #ffffff / hsl(…)"
            value={colorAt('color')}
            onchange={(e) => setStyleColor('color', (e.currentTarget as HTMLInputElement).value)}
          />
        </span>
        <label for="in-bg">Background</label>
        <span class="colorrow">
          <span class="swatch"><span class="swatchfill" style="background-color:{colorAt('backgroundColor') || 'transparent'}"></span></span>
          <input
            id="in-bg"
            type="text"
            placeholder="(none)"
            value={colorAt('backgroundColor')}
            onchange={(e) => setStyleColor('backgroundColor', (e.currentTarget as HTMLInputElement).value)}
          />
        </span>
      </div>
      <div class="grid three spaced">
        {#each TEXT_STYLE_PROPS as np (np.prop)}
          {@render propRow(np)}
        {/each}
      </div>
      <div class="grid">
        <label for="in-pad-top">Padding</label>
        <span class="padrow">
          {#each PAD_LABELS as side, i (side)}
            <input
              id="in-pad-{side}"
              type="number"
              step="1"
              title="padding {side}"
              value={el.padding?.[i] ?? 0}
              onchange={(e) => setPadding(i, (e.currentTarget as HTMLInputElement).value)}
            />
          {/each}
        </span>
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
        <label for="in-placeholder">Placeholder</label>
        <input
          id="in-placeholder"
          type="text"
          placeholder="assets/…  (design-time image)"
          value={el.placeholder ?? ''}
          onchange={(e) => setElementField('placeholder', (e.currentTarget as HTMLInputElement).value.trim() || undefined)}
        />
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
      Animate: move the playhead, click ◆ to set a keyframe (click again to
      remove). Dim ◆ = property animated · gold = keyframe at playhead. Number
      edits on animated properties write a keyframe at the playhead. Stage
      drags move the whole curve (and masks). Select diamonds in the timeline
      to retime or ease.
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
  .linkish {
    background: none;
    border: none;
    color: #8a8f98;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 11px;
    padding: 0;
    cursor: pointer;
  }
  .linkish:hover { color: #cfd3da; }
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
  .colorrow { display: flex; gap: 5px; align-items: center; min-width: 0; }
  .colorrow input { flex: 1; min-width: 0; }
  .swatch {
    width: 16px; height: 16px; flex: none; border-radius: 3px; overflow: hidden;
    border: 1px solid #444a55;
    background-image: repeating-conic-gradient(#3a3f4a 0% 25%, #2a2e38 0% 50%);
    background-size: 8px 8px;
  }
  .swatchfill { display: block; width: 100%; height: 100%; }
  .grid.spaced { margin-top: 10px; }
  .padrow { display: flex; gap: 4px; min-width: 0; }
  .padrow input { flex: 1; min-width: 0; width: 100%; }
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
