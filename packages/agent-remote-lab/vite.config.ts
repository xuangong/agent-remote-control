import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { FILE_FRAME_PATH, fileFrameDocument, fileFrameHeaders } from '@orchardworks/agent-remote-hosted';

const relayTarget = process.env.VITE_AGENT_REMOTE_RELAY_TARGET ?? 'http://127.0.0.1:4910';
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react(), {
    name: 'agent-file-frame',
    configureServer(server) {
      server.middlewares.use(FILE_FRAME_PATH, (_request, response) => { response.writeHead(200, fileFrameHeaders); response.end(fileFrameDocument); });
    },
  }],
  server: {
    proxy: {
      '/v1': {
        target: relayTarget,
        ws: true,
      },
    },
  },
});
