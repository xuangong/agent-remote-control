import { defineConfig } from 'vitest/config';
import { workspaceSource } from '../../scripts/lib/workspace-source.mjs';
import { SlowTestReporter } from '../../scripts/lib/slow-test-reporter.mjs';

// Transport tests use a real loopback socket on a free port: the runtime's HTTP server and the client's transport. They run after a change to either.
export default defineConfig({
  plugins: [workspaceSource()],
  test: { reporters: ['default', new SlowTestReporter()], slowTestThreshold: 300, include: ['tests/**/*.transport.test.ts'], testTimeout: 15000 },
});
