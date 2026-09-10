import type { CodexAppServerProvider } from '@borgee/agent-provider-codex';
import { createCodexSessionDirectory } from '@borgee/agent-host';
import type { SessionDirectorySource } from './session-directory.js';

/** Test-only compatibility adapter for direct native Provider fixtures. */
export function createCodexDirectory(provider: Pick<CodexAppServerProvider, 'listSessions' | 'createSession' | 'resumeSession' | 'openChildSession'>, workspace: string): SessionDirectorySource {
  const directory = createCodexSessionDirectory(provider, [{ id: workspace, path: workspace, name: workspace }]);
  return { ...directory, async close() { await directory.close(); } };
}
