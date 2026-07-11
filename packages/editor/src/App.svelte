<script lang="ts">
  import Sidebar from './lib/Sidebar.svelte';
  import Stage from './lib/Stage.svelte';
  import Timeline from './lib/Timeline.svelte';
  import Inspector from './lib/Inspector.svelte';
  import { ed } from './lib/state.svelte.ts';

  $effect(() => {
    void (async () => {
      await ed.loadSets();
      // deep link: /?set=FIE_2026&scene=FIE_2026_HD_MedalCounts[&frame=50]
      const params = new URLSearchParams(location.search);
      const setName = params.get('set');
      if (!setName) return;
      const ref = ed.sets.find((s) => s.name === setName);
      if (!ref) return;
      await ed.openSet(ref);
      const sceneName = params.get('scene');
      if (sceneName) {
        const file = ref.scenes.find((f) => f.includes(sceneName));
        if (file) ed.openScene(file);
      }
      const frame = params.get('frame');
      if (frame) ed.frame = Number(frame);
    })();
  });

  function isTyping(): boolean {
    const t = document.activeElement?.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.ctrlKey && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      void ed.save();
      return;
    }
    if (ev.ctrlKey && ev.key.toLowerCase() === 'z') {
      if (isTyping()) return;
      ev.preventDefault();
      if (ev.shiftKey) ed.redo();
      else ed.undo();
      return;
    }
    if (ev.ctrlKey && ev.key.toLowerCase() === 'y') {
      if (isTyping()) return;
      ev.preventDefault();
      ed.redo();
      return;
    }
    if (isTyping() || !ed.scene) return;
    const dur = ed.scene.composition.duration;
    switch (ev.key) {
      case ' ':
        ev.preventDefault();
        ed.playing = !ed.playing;
        break;
      case 'ArrowLeft':
        ed.playing = false;
        ed.frame = Math.max(0, ed.frame - (ev.shiftKey ? 10 : 1));
        break;
      case 'ArrowRight':
        ed.playing = false;
        ed.frame = Math.min(dur - 1, ed.frame + (ev.shiftKey ? 10 : 1));
        break;
      case 'Home':
        ed.frame = 0;
        break;
      case 'End':
        ed.frame = dur - 1;
        break;
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="app">
  <header>
    <h1>Riposte</h1>
    <span class="scene-name">
      {ed.setRef?.name ?? ''}{ed.sceneFile ? ` / ${ed.sceneFile.replace(/^scenes\//, '').replace(/\.json$/, '')}` : ''}
      {#if ed.dirty}<span class="dirty">●</span>{/if}
    </span>
    <span class="spacer"></span>
    <span class="status">{ed.status}</span>
    <button onclick={() => ed.undo()} title="Ctrl+Z">↶</button>
    <button onclick={() => ed.redo()} title="Ctrl+Y">↷</button>
    <button class="primary" onclick={() => ed.save()} disabled={!ed.dirty} title="Ctrl+S">Save</button>
  </header>
  <div class="main">
    <Sidebar />
    <Stage />
    <Inspector />
  </div>
  <Timeline />
</div>

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, sans-serif;
    background: #16181d;
    color: #e6e6e6;
    overflow: hidden;
  }
  .app {
    display: grid;
    grid-template-rows: auto 1fr 240px;
    height: 100vh;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    border-bottom: 1px solid #2c2f38;
  }
  h1 {
    font-size: 14px;
    letter-spacing: 0.3em;
    font-weight: 400;
    text-transform: uppercase;
    color: #d9a441;
    margin: 0;
  }
  .scene-name { font-size: 13px; color: #aab; }
  .dirty { color: #d9a441; }
  .spacer { flex: 1; }
  .status { color: #7fb069; font-size: 12px; }
  header button {
    background: #23262e;
    border: 1px solid #383c46;
    color: #e6e6e6;
    border-radius: 4px;
    padding: 3px 12px;
    cursor: pointer;
  }
  header button.primary { background: #2c4a75; }
  header button:disabled { opacity: 0.4; cursor: default; }
  .main {
    display: grid;
    grid-template-columns: 250px 1fr 270px;
    min-height: 0;
  }
</style>
