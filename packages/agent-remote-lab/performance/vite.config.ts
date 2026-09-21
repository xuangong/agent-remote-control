import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)), plugins: [react()],
  build: { outDir: process.env.ARC_PERFORMANCE_BUILD ?? '.tmp/performance-build', emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./index.html', import.meta.url)) } },
});
