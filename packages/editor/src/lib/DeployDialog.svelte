<script lang="ts">
  import { ed } from './state.svelte.ts';

  let targetDir = $state('');
  let force = $state(false);

  // re-seed whenever the dialog opens: last used path, force always off
  $effect(() => {
    if (!ed.deployDialogOpen) return;
    targetDir = localStorage.getItem('riposte.deployDir') ?? localStorage.getItem('riposte.exportDir') ?? '';
    force = false;
  });

  function deploy(): void {
    if (!targetDir.trim()) return;
    ed.deployDialogOpen = false;
    void ed.deployTo(targetDir.trim(), force);
  }

  function onKey(ev: KeyboardEvent): void {
    if (!ed.deployDialogOpen) return;
    if (ev.key === 'Escape') ed.deployDialogOpen = false;
    if (ev.key === 'Enter') deploy();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if ed.deployDialogOpen && ed.setRef}
  <div class="overlay" role="presentation" onclick={() => (ed.deployDialogOpen = false)}>
    <div class="dialog" role="dialog" aria-label="Deploy set" onclick={(ev) => ev.stopPropagation()}>
      <h2>{ed.setRef.name} <span class="dim">deploy</span></h2>
      <p class="meta">export + copy into the CasparCG template directory — additive, nothing is deleted</p>

      <label class="lbl" for="dd-target">Target directory</label>
      <input
        id="dd-target"
        type="text"
        bind:value={targetDir}
        placeholder="e.g. C:\CasparCG\template"
        spellcheck="false"
        {@attach (node) => { (node as HTMLInputElement).focus(); }}
      />

      <label class="check">
        <input type="checkbox" bind:checked={force} />
        Force full redeploy — copy every file, even unchanged ones
      </label>
      <p class="hint">
        Normally only changed files are copied. Use force after cleaning or
        hand-editing the target directory, or when the incremental state looks
        suspect.
      </p>

      <div class="row">
        <button class="primary" onclick={deploy} disabled={!targetDir.trim()}>Deploy</button>
        <button onclick={() => (ed.deployDialogOpen = false)}>Cancel</button>
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
  .check {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: #aab;
    margin-top: 12px;
    cursor: pointer;
  }
  .hint { font-size: 11px; color: #8a8f98; line-height: 1.5; margin: 6px 0 0 22px; }
  .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  button { background: #23262e; color: #e6e6e6; border: 1px solid #383c46; border-radius: 5px; padding: 6px 14px; font-size: 12px; cursor: pointer; }
  button:hover { border-color: #d9a441; }
  button:disabled { opacity: 0.5; cursor: default; }
  .primary { background: #2c4a75; }
</style>
