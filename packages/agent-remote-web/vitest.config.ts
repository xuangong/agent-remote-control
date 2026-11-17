import { defineConfig } from 'vitest/config';
import { workspaceSource } from '../../scripts/lib/workspace-source.mjs';
import { SlowTestReporter } from '../../scripts/lib/slow-test-reporter.mjs';

export default defineConfig({
  plugins: [workspaceSource()],
  test: {
    reporters: ['default', new SlowTestReporter()],
    slowTestThreshold: 300,
    environment: 'node',
  },
});
