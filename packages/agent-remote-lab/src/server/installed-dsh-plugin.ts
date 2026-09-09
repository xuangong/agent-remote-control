import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { apply as applyLivePlugin, type Config as LiveConfig } from './live-plugin.js';
import { loadCompatibilityManifest, requireProviderCompatibility } from './compatibility.js';

export const name = 'borgee-agent-remote-lab';
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'sessionController', 'sessionQuery', 'workspaceRegistry', 'agentPresets'];

export interface Config {
  codexFixture?: boolean;
}

export function apply(context: Parameters<typeof applyLivePlugin>[0], config: Config = {}): Promise<void> {
  const compatibilityManifest = fileURLToPath(new URL('../compatibility.json', import.meta.url));
  const expected = requireProviderCompatibility(loadCompatibilityManifest(compatibilityManifest), 'dsh').native.version;
  assertNativeDshVersions(expected);
  const liveConfig: LiveConfig = {
    runtimeMode: 'shared-web',
    codexFixture: config.codexFixture ?? false,
    compatibilityManifest,
  };
  return applyLivePlugin(context, liveConfig);
}

export function assertNativeDshVersions(expected: string, versionForPackage = installedPackageVersion): void {
  for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session']) {
    const version = versionForPackage(name);
    if (version !== expected) throw new Error(`The Agent Remote Lab plugin requires ${name} ${expected}; got ${version ?? 'unknown'}.`);
  }
}

function installedPackageVersion(name: string): string | undefined {
  const require = createRequire(import.meta.url);
  const metadata = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as { version?: string };
  return metadata.version;
}
