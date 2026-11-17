import { defineConfig } from 'vitest/config';
import { workspaceSource } from '../../scripts/lib/workspace-source.mjs';

// The recorder plays a contract against the real modules and writes the replies; it is not part of any test run.
export default defineConfig({ plugins: [workspaceSource()], test: { include: ['record/*.record.ts'] } });
