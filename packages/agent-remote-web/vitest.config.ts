import { defineConfig } from 'vitest/config';
import { workspaceSource } from '../../scripts/lib/workspace-source.mjs';

export default defineConfig({
  plugins: [workspaceSource()],
  test: {
    environment: 'node',
  },
});
