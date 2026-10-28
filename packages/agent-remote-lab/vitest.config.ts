import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Test servers default their succession, image and resource state to the home directory.
// Keep each run's state out of the developer's own, where it would accumulate across runs.
const home = mkdtempSync(join(tmpdir(), 'arc-lab-test-home-'));
process.on('exit', () => rmSync(home, { recursive: true, force: true }));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    testTimeout: 10_000,
    env: { HOME: home, USERPROFILE: home },
  },
});
