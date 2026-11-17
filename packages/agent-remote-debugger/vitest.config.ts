import { defineConfig } from 'vitest/config';
import { workspaceSource } from '../../scripts/lib/workspace-source.mjs';
import { SlowTestReporter } from '../../scripts/lib/slow-test-reporter.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The recorded Lab Relay defaults its succession, image and resource state to the home directory.
// Keep each run's state out of the developer's own, where it would accumulate across runs.
const home = mkdtempSync(join(tmpdir(), 'arc-debugger-test-home-'));
process.on('exit', () => rmSync(home, { recursive: true, force: true }));

export default defineConfig({ plugins: [workspaceSource()], test: { reporters: ['default', new SlowTestReporter()], slowTestThreshold: 300, fileParallelism: false, include: ['src/**/*.test.ts'], testTimeout: 10000, hookTimeout: 60000, env: { HOME: home, USERPROFILE: home } } });
