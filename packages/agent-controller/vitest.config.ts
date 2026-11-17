import { configDefaults, defineConfig } from 'vitest/config';
import { workspaceSource } from '../../scripts/lib/workspace-source.mjs';
import { SlowTestReporter } from '../../scripts/lib/slow-test-reporter.mjs';

// Tests that start child processes or wait on real timers; they are slow and load-sensitive, so they form their own project.
const processTests = ['src/cli-*.test.ts', 'src/opencode-server*.test.ts', 'src/codex-daemon-runner.test.ts', 'src/vscode-tunnel*.test.ts'];
// Native tests need this machine's installed agents and run through `pnpm test:local`.
const excluded = [...configDefaults.exclude, '**/*.local.test.ts', '**/*.local.test.tsx'];

export default defineConfig({
  plugins: [workspaceSource()],
  test: {
    reporters: ['default', new SlowTestReporter()],
    slowTestThreshold: 300,
    projects: [
      { extends: true, test: { name: 'unit', exclude: [...excluded, ...processTests] } },
      { extends: true, test: { name: 'process', include: processTests, exclude: excluded } },
    ],
  },
});
