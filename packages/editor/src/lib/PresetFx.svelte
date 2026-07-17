<script lang="ts">
  import type { BezierEasing, Keyframe, StyleProperty } from '@riposte/shared';
  import { ed } from './state.svelte.ts';

  const fx = $derived(ed.fxEdit);
  const comp = $derived(ed.scene?.composition ?? null);

  interface FxPropDef {
    prop: string;
    label: string;
    hint: string;
    /** neutral value — seed for the first keyframe when the prop is enabled */
    neutral: number;
  }

  const STYLE_PROPS: FxPropDef[] = [
    { prop: 'opacity', label: 'Opacity', hint: '0–1', neutral: 1 },
    { prop: 'x', label: 'X shift', hint: 'px', neutral: 0 },
    { prop: 'y', label: 'Y shift', hint: 'px', neutral: 0 },
    { prop: 'scaleX', label: 'Scale X', hint: '×', neutral: 1 },
    { prop: 'scaleY', label: 'Scale Y', hint: '×', neutral: 1 },
    { prop: 'rotation', label: 'Rotation', hint: '°', neutral: 0 },
  ];

  const EASINGS: Record<string, BezierEasing | null> = {
    linear: null,
    'ease-out': { p1x: 0, p1y: 0, p2x: 0.5, p2y: 1 },
    'ease-in': { p1x: 0.42, p1y: 0, p2x: 1, p2y: 1 },
    'ease-in-out': { p1x: 0.42, p1y: 0, p2x: 0.58, p2y: 1 },
    ease: { p1x: 0.25, p1y: 0.1, p2x: 0.25, p2y: 1 },
  };

  function easingName(e: BezierEasing | undefined): string {
    if (!e) return 'linear';
    for (const [name, p] of Object.entries(EASINGS)) {
      if (p && p.p1x === e.p1x && p.p1y === e.p1y && p.p2x === e.p2x && p.p2y === e.p2y) return name;
    }
    return 'custom';
  }

  /** Mask x/y default to the comp center (runtime semantics). */
  function maskNeutral(prop: string): number {
    if (prop === 'x') return Math.round((comp?.width ?? 1920) / 2);
    if (prop === 'y') return Math.round((comp?.height ?? 1080) / 2);
    return 0;
  }

  const MASK_PROPS: FxPropDef[] = $derived([
    { prop: 'x', label: 'X', hint: 'px center', neutral: maskNeutral('x') },
    { prop: 'y', label: 'Y', hint: 'px center', neutral: maskNeutral('y') },
    { prop: 'width', label: 'W', hint: 'px', neutral: 0 },
    { prop: 'height', label: 'H', hint: 'px', neutral: 0 },
    { prop: 'rotation', label: 'Rot', hint: '°', neutral: 0 },
  ]);

  function styleOf(target: 'style' | 'mask'): Record<string, StyleProperty> | null {
    if (!fx) return null;
    if (target === 'style') return (fx.preset.style ??= {});
    return fx.preset.mask ? fx.preset.mask.style : null;
  }

  /** Enable = seed neutral → neutral over the full duration; disable = remove. */
  function toggleProp(target: 'style' | 'mask', def: FxPropDef, on: boolean): void {
    const s = styleOf(target);
    if (!s || !fx) return;
    if (on) {
      s[def.prop] = {
        value: def.neutral,
        keyframes: [
          { frame: 0, value: def.neutral },
          { frame: fx.preset.duration, value: def.neutral },
        ],
      };
    } else {
      delete s[def.prop];
    }
  }

  function kfsOf(target: 'style' | 'mask', prop: string): Keyframe[] {
    return styleOf(target)?.[prop]?.keyframes ?? [];
  }

  function setKfNumber(sp: StyleProperty, kf: Keyframe, field: 'frame' | 'value', raw: string): void {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    if (field === 'frame') {
      kf.frame = Math.max(0, Math.round(v));
      sp.keyframes?.sort((a, b) => a.frame - b.frame);
    } else {
      kf.value = v;
    }
  }

  function addKf(target: 'style' | 'mask', prop: string): void {
    const sp = styleOf(target)?.[prop];
    if (!sp || !fx) return;
    sp.keyframes ??= [];
    const last = sp.keyframes[sp.keyframes.length - 1];
    const seed = typeof last?.value === 'number' ? last.value : typeof sp.value === 'number' ? sp.value : 0;
    const frame = last ? Math.min(fx.preset.duration, last.frame + Math.max(1, Math.round(fx.preset.duration / 2))) : 0;
    sp.keyframes.push({ frame, value: seed });
    sp.keyframes.sort((a, b) => a.frame - b.frame);
  }

  function removeKf(target: 'style' | 'mask', prop: string, index: number): void {
    const sp = styleOf(target)?.[prop];
    sp?.keyframes?.splice(index, 1);
  }

  function setEasing(kf: Keyframe, name: string): void {
    const p = EASINGS[name];
    if (p) kf.easing = { ...p };
    else if (name === 'linear') delete kf.easing;
  }

  function toggleMask(on: boolean): void {
    if (!fx) return;
    if (on) {
      fx.preset.mask = {
        style: {
          width: { value: comp?.width ?? 1920 },
          height: { value: comp?.height ?? 1080 },
        },
      };
    } else {
      delete fx.preset.mask;
    }
  }

  // ---- preview playback (wall clock, like the runtime) -----------------------
  let playToken = 0;
  function play(): void {
    if (!fx) return;
    const token = ++playToken;
    const start = performance.now();
    const fps = comp?.fps ?? 50;
    const dur = fx.preset.duration;
    const tick = (): void => {
      const cur = ed.fxEdit;
      if (!cur || token !== playToken) return;
      const f = Math.min(dur, ((performance.now() - start) / 1000) * fps);
      cur.previewFrame = f;
      if (f < dur) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function stopPlay(): void {
    playToken++;
  }

  async function save(): Promise<void> {
    stopPlay();
    await ed.saveFxPreset();
  }

  function del(): void {
    if (!fx?.source) return;
    if (!confirm(`Delete ${fx.folder.slice(0, -1)} "${fx.source}"? Scenes referencing it fall back to default behavior.`)) return;
    void ed.deleteFxPreset(fx.folder, fx.source);
  }

  function close(): void {
    stopPlay();
    ed.closeFxEditor();
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && ed.fxEdit) close();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if fx}
  <div class="panel" role="dialog" aria-label="Effect preset editor">
    <div class="head">
      <h2>{fx.folder === 'intros' ? 'Intro' : 'Outro'} preset</h2>
      <span class="dim">{fx.source ? `editing ${fx.source}` : 'new'}</span>
      <span class="spacer"></span>
      <button class="icon" title="Close (Esc) — unsaved changes are discarded" onclick={close}>✕</button>
    </div>

    <div class="grid">
      <label for="fx-name">Name</label>
      <input id="fx-name" type="text" placeholder="e.g. wipe-up" bind:value={fx.preset.name} />
      <label for="fx-dur">Duration</label>
      <span class="row">
        <input id="fx-dur" class="num" type="number" min="1" step="1" bind:value={fx.preset.duration} />
        <span class="dim">frames @ {comp?.fps ?? '?'} fps</span>
      </span>
    </div>

    <div class="preview">
      <button title="Play the effect on the stage" onclick={play}>▶</button>
      <button title="Back to frame 0" onclick={() => { stopPlay(); if (fx) fx.previewFrame = 0; }}>⏮</button>
      <input
        type="range"
        min="0"
        max={fx.preset.duration}
        step="0.5"
        value={fx.previewFrame}
        oninput={(e) => { stopPlay(); if (fx) fx.previewFrame = Number((e.currentTarget as HTMLInputElement).value); }}
      />
      <span class="fr">{Math.round(fx.previewFrame * 10) / 10}</span>
    </div>
    <p class="hint">
      {fx.folder === 'intros'
        ? 'Frame 0 = hidden start, last frame = neutral (the scene as designed).'
        : 'Frame 0 = neutral, last frame = gone (the scene hides after it).'}
      The stage previews the slider position live.
    </p>

    <h3>Scene root</h3>
    {#each STYLE_PROPS as def (def.prop)}
      {@const active = !!fx.preset.style?.[def.prop]}
      <div class="prop">
        <label class="propname">
          <input type="checkbox" checked={active} onchange={(e) => toggleProp('style', def, (e.currentTarget as HTMLInputElement).checked)} />
          {def.label} <span class="dim">{def.hint}</span>
        </label>
        {#if active}
          {#each kfsOf('style', def.prop) as kf, i (i)}
            {@const sp = fx.preset.style?.[def.prop]}
            <div class="kf">
              <span class="at">@</span>
              <input class="num" type="number" step="1" value={kf.frame}
                onchange={(e) => sp && setKfNumber(sp, kf, 'frame', (e.currentTarget as HTMLInputElement).value)} />
              <span class="at">=</span>
              <input class="num wide" type="number" step="any" value={kf.value}
                onchange={(e) => sp && setKfNumber(sp, kf, 'value', (e.currentTarget as HTMLInputElement).value)} />
              <select value={easingName(kf.easing)} onchange={(e) => setEasing(kf, (e.currentTarget as HTMLSelectElement).value)}>
                {#each Object.keys(EASINGS) as name (name)}
                  <option value={name}>{name}</option>
                {/each}
                {#if easingName(kf.easing) === 'custom'}<option value="custom">custom</option>{/if}
              </select>
              <button class="icon" title="Remove keyframe" onclick={() => removeKf('style', def.prop, i)}>✕</button>
            </div>
          {/each}
          <button class="minor" onclick={() => addKf('style', def.prop)}>+ keyframe</button>
        {/if}
      </div>
    {/each}

    <h3>
      <label class="propname">
        <input type="checkbox" checked={!!fx.preset.mask} onchange={(e) => toggleMask((e.currentTarget as HTMLInputElement).checked)} />
        Mask <span class="dim">rect clip on the whole scene</span>
      </label>
    </h3>
    {#if fx.preset.mask}
      <label class="propname inv">
        <input type="checkbox" checked={fx.preset.mask.inverted ?? false}
          onchange={(e) => { if (fx.preset.mask) { if ((e.currentTarget as HTMLInputElement).checked) fx.preset.mask.inverted = true; else delete fx.preset.mask.inverted; } }} />
        Inverted <span class="dim">scene visible OUTSIDE the rect (diamond etc.)</span>
      </label>
      {#each MASK_PROPS as def (def.prop)}
        {@const sp = fx.preset.mask.style[def.prop]}
        <div class="prop">
          <label class="propname">
            <input type="checkbox" checked={!!sp} onchange={(e) => toggleProp('mask', def, (e.currentTarget as HTMLInputElement).checked)} />
            {def.label} <span class="dim">{def.hint}</span>
          </label>
          {#if sp}
            {#if !sp.keyframes?.length}
              <div class="kf">
                <span class="at">=</span>
                <input class="num wide" type="number" step="any" value={sp.value}
                  onchange={(e) => { const v = Number((e.currentTarget as HTMLInputElement).value); if (Number.isFinite(v)) sp.value = v; }} />
                <span class="dim">static</span>
              </div>
            {/if}
            {#each sp.keyframes ?? [] as kf, i (i)}
              <div class="kf">
                <span class="at">@</span>
                <input class="num" type="number" step="1" value={kf.frame}
                  onchange={(e) => setKfNumber(sp, kf, 'frame', (e.currentTarget as HTMLInputElement).value)} />
                <span class="at">=</span>
                <input class="num wide" type="number" step="any" value={kf.value}
                  onchange={(e) => setKfNumber(sp, kf, 'value', (e.currentTarget as HTMLInputElement).value)} />
                <select value={easingName(kf.easing)} onchange={(e) => setEasing(kf, (e.currentTarget as HTMLSelectElement).value)}>
                  {#each Object.keys(EASINGS) as name (name)}
                    <option value={name}>{name}</option>
                  {/each}
                  {#if easingName(kf.easing) === 'custom'}<option value="custom">custom</option>{/if}
                </select>
                <button class="icon" title="Remove keyframe" onclick={() => removeKf('mask', def.prop, i)}>✕</button>
              </div>
            {/each}
            <button class="minor" onclick={() => addKf('mask', def.prop)}>+ keyframe</button>
          {/if}
        </div>
      {/each}
      <p class="hint">Points may run far beyond the frame borders — a growing hole needs w/h way past the comp size (e.g. 0 → 4000).</p>
    {/if}

    <div class="foot">
      {#if fx.source}
        <button class="danger" onclick={del}>Delete</button>
      {/if}
      <span class="spacer"></span>
      <button onclick={close}>Close</button>
      <button class="primary" onclick={save}>
        {fx.source && fx.source !== fx.preset.name.trim() ? 'Save as' : 'Save'}
      </button>
    </div>
  </div>
{/if}

<style>
  .panel {
    position: fixed;
    top: 44px;
    right: 8px;
    bottom: 12px;
    width: 340px;
    overflow-y: auto;
    background: #1b1e24;
    border: 1px solid #3a3e48;
    border-radius: 8px;
    padding: 12px 14px;
    color: #e6e6e6;
    z-index: 15000;
    box-shadow: 0 6px 30px rgba(0, 0, 0, 0.5);
    font-size: 12px;
  }
  .head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  h2 { font-size: 14px; margin: 0; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #8a8f98; margin: 14px 0 6px; }
  .spacer { flex: 1; }
  .dim { color: #8a8f98; font-size: 11px; text-transform: none; letter-spacing: 0; }
  .grid { display: grid; grid-template-columns: max-content 1fr; gap: 6px 10px; align-items: center; }
  label { font-size: 12px; color: #aab; }
  input, select {
    background: #23262e; color: #e6e6e6; border: 1px solid #383c46;
    border-radius: 4px; padding: 3px 7px; font-size: 12px; width: 100%;
  }
  input[type='checkbox'] { width: auto; }
  .num { width: 58px; }
  .num.wide { width: 74px; }
  .row { display: flex; gap: 8px; align-items: center; }
  .preview { display: flex; gap: 6px; align-items: center; margin: 10px 0 4px; }
  .preview input[type='range'] { flex: 1; padding: 0; }
  .preview button { width: auto; }
  .fr { width: 34px; text-align: right; color: #aab; font-variant-numeric: tabular-nums; }
  .prop { margin: 6px 0; }
  .propname { display: flex; gap: 6px; align-items: center; cursor: pointer; }
  .propname.inv { margin: 4px 0 8px; }
  .kf { display: flex; gap: 4px; align-items: center; margin: 4px 0 0 22px; }
  .kf select { width: 96px; }
  .at { color: #676c76; }
  button {
    background: #23262e; color: #e6e6e6; border: 1px solid #383c46;
    border-radius: 4px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  button:hover { border-color: #d9a441; }
  button.icon { padding: 2px 7px; }
  button.minor { margin: 4px 0 0 22px; padding: 2px 8px; font-size: 11px; color: #aab; }
  button.primary { background: #2c4a75; }
  button.danger { border-color: #7a3a3a; color: #e0a0a0; }
  .hint { font-size: 11px; color: #8a8f98; line-height: 1.45; margin: 4px 0 0; }
  .foot { display: flex; gap: 8px; align-items: center; margin-top: 14px; }
</style>
