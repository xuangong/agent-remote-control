import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: { claude: 'src/providers/claude.ts', copilot: 'src/providers/copilot.ts', 'catalog-worker': '../agent-provider-claude/src/catalog-worker.ts' },
  outdir: 'dist/providers', bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: true,
  external: ['@anthropic-ai/claude-agent-sdk', '@github/copilot-sdk', '@github/copilot', '@orchardworks/agent-provider-sdk'],
});
