import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const relayTarget = process.env.VITE_AGENT_REMOTE_RELAY_TARGET ?? 'http://127.0.0.1:4910';
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    proxy: {
      '/v1': {
        target: relayTarget,
        ws: true,
      },
    },
  },
});
