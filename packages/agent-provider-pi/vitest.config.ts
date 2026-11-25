import { configDefaults, defineConfig } from 'vitest/config';
import { workspaceSource } from '../../scripts/lib/workspace-source.mjs';
import { SlowTestReporter } from '../../scripts/lib/slow-test-reporter.mjs';

// The tests under `tests/` start the pinned pi CLI as a child process against a scripted loopback model
// (`src/test-utils/native-fixture.ts`): the process tier, outside the speed rule for mock-data tests.
const processTests = ['tests/**/*.test.ts'];

export default defineConfig({
  plugins: [workspaceSource()],
  test: {
    reporters: ['default', new SlowTestReporter()],
    slowTestThreshold: 300,
    projects: [
      { extends: true, test: { name: 'unit', exclude: [...configDefaults.exclude, ...processTests] } },
      { extends: true, test: { name: 'process', include: processTests } },
    ],
  },
});
