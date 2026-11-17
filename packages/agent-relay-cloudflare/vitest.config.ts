import { defineConfig } from 'vitest/config';
import { workspaceSource } from '../../scripts/lib/workspace-source.mjs';
import { SlowTestReporter } from '../../scripts/lib/slow-test-reporter.mjs';

// `unit` holds the tests that run in Node. `workers` holds the tests that start `workerd` through Miniflare; they prove
// what only the Workers runtime proves, and no Relay rule.
export default defineConfig({
  plugins: [workspaceSource()],
  test: {
    reporters: ['default', new SlowTestReporter()], slowTestThreshold: 300, hookTimeout: 30_000,
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/**/*.test.ts'], exclude: ['test/**/*.workers.test.ts'] } },
      { extends: true, test: { name: 'workers', include: ['test/**/*.workers.test.ts'] } },
    ],
  },
});
