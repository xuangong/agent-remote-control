import { defineConfig } from 'vitest/config';
import { workspaceSource } from '../../scripts/lib/workspace-source.mjs';
import { SlowTestReporter } from '../../scripts/lib/slow-test-reporter.mjs';

// Seam tests use mock data and in-memory ports, so each one must finish well inside the one second limit.
export default defineConfig({
  plugins: [workspaceSource()],
  test: { reporters: ['default', new SlowTestReporter()], slowTestThreshold: 300, include: ['tests/**/*.integration.test.{ts,tsx}'], testTimeout: 1000 },
});
