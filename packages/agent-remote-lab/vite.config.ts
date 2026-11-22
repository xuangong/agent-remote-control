import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { FILE_FRAME_PATH, fileFrameDocument, fileFrameHeaders } from '@orchardworks/agent-relay-core';
import { bundleBudget } from './bundle-budget.js';
import { appShellWorker } from './app-shell-plugin.js';

const relayTarget = process.env.VITE_AGENT_REMOTE_RELAY_TARGET ?? 'http://127.0.0.1:4910';
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  // Measured after stage 6 (2026-11-14): entry 63.6 KB and App 544 KB gzip; about 10% to grow before a build fails.
  plugins: [react(), bundleBudget([{ chunk: 'entry', gzipBytes: 70_000 }, { chunk: 'App', gzipBytes: 600_000 }]),
    // The installed app's service worker (/sw.js) with this build's shell: the entry and the App chunk it loads at once.
    appShellWorker({ worker: fileURLToPath(new URL('./src/app-shell/service-worker.ts', import.meta.url)), startChunks: ['App'] }), {
    name: 'agent-file-frame',
    configureServer(server) {
      server.middlewares.use(FILE_FRAME_PATH, (_request, response) => { response.writeHead(200, fileFrameHeaders); response.end(fileFrameDocument); });
    },
  }],
  // No modulepreload links for code-split JavaScript: WebKit keeps a failed `modulepreload` response for its URL across reloads and
  // navigations, so a chunk whose first fetch failed could never load again and the page stayed empty (O54). An `import()` that failed is
  // fetched again after a reload, which is how `loadChunkWithRecovery` recovers. A chunk's CSS is still loaded by the preload helper.
  build: { modulePreload: false },
  server: {
    proxy: {
      '/v1': {
        target: relayTarget,
        ws: true,
      },
    },
  },
});
