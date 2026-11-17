import { defineConfig } from 'vitest/config';
import { SlowTestReporter } from '../../scripts/lib/slow-test-reporter.mjs';

// Invariant and harness tests use constructed data and finish well under 300 ms. The `*.transport.test.ts` files in faults/
// run the proxies over real loopback sockets with a 2 s budget. Smoke scenarios are not tests: `pnpm smoke` runs them.
export default defineConfig({
  test: { reporters: ['default', new SlowTestReporter()], slowTestThreshold: 300, include: ['faults/**/*.test.ts', 'smoke/**/*.test.ts'], testTimeout: 2000 },
});
