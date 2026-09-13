import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      '/v1': { target: 'http://localhost:8787', changeOrigin: true },
      '/weaknet': { target: 'http://localhost:8787', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  // Player engines (hls.js / mpegts.js) are only ever `import()`ed by player-core, so Rolldown
  // already emits them as separate chunks: the room page shell stays small and only the engine
  // actually used by the selected pathway is downloaded.
  build: { sourcemap: true },
});
