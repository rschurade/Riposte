<script lang="ts">
  import { SCENE_FORMAT_VERSION } from '@riposte/shared';
</script>

<main>
  <h1>Riposte</h1>
  <p>Template studio for CasparCG — scene format v{SCENE_FORMAT_VERSION}.</p>
  <p class="hint">Editor shell. Canvas, timeline and inspector arrive in phase 3.</p>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, sans-serif;
    background: #1b1d21;
    color: #e6e6e6;
  }
  main {
    display: grid;
    place-content: center;
    min-height: 100vh;
    text-align: center;
  }
  h1 {
    font-weight: 300;
    letter-spacing: 0.3em;
    text-transform: uppercase;
  }
  .hint {
    color: #8a8f98;
  }
</style>
