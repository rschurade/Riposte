import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const backend = 'http://localhost:5720';

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5719,
    proxy: {
      '/api': backend,
      '/examples': backend,
      '/projects': backend,
      '/runtime.js': backend,
    },
  },
});
