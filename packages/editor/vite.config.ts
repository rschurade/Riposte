import { defineConfig, type ProxyOptions } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const backend = 'http://localhost:5720';

/**
 * On upstream failure (backend restart kills an SSE stream) DESTROY the
 * browser-side socket instead of leaving it open: half-dead streams pile up
 * until Chrome's 6-connections-per-origin limit is hit and every further
 * fetch queues forever (frozen editor, spinner never stops).
 */
const proxied = (): ProxyOptions => ({
  target: backend,
  configure(proxy) {
    proxy.on('error', (_err, _req, res) => {
      if ('destroy' in res) (res as import('node:http').ServerResponse).destroy();
    });
  },
});

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5719,
    proxy: {
      '/api': proxied(),
      '/examples': proxied(),
      '/projects': proxied(),
      '/runtime.js': proxied(),
      '/playout.html': proxied(),
      '/playout.js': proxied(),
    },
  },
});
