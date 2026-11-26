import { defineConfig } from 'vitest/config';
import { chromiumOnlyFlowGlobs } from '../../scripts/lib/chromium-only-flows.mjs';
import { workspaceSource } from '../../scripts/lib/workspace-source.mjs';

// The main flows of the product: a real browser against a real Relay and Controller with a scripted provider. They run one at a time
// in one worker, share one stack per file, and each flow has its own 30 s deadline; the run as a whole is bounded by the caller.
// `E2E_BROWSER=webkit` skips the Chromium-only flows (scripts/lib/chromium-only-flows.mjs).
export default defineConfig({
  plugins: [workspaceSource()],
  test: { include: ['flows/**/*.e2e.ts'], exclude: process.env.E2E_BROWSER === 'webkit' ? chromiumOnlyFlowGlobs() : [], testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false, maxWorkers: 1 },
});
