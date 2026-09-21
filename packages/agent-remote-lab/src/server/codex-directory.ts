import type { CodexAppServerProvider } from '@orchardworks/agent-provider-codex';
import { join } from 'node:path';
import { SessionReferenceStore, createCodexSessionDirectory } from '@orchardworks/agent-remote-controller';
import type { SessionDirectorySource } from './session-directory.js';

/** Test-only compatibility adapter for direct native Provider fixtures. */
export function createCodexDirectory(provider: Pick<CodexAppServerProvider, 'listSessions' | 'createSession' | 'resumeSession' | 'openChildSession'> & Partial<Pick<CodexAppServerProvider, 'readSessionHistory'>>,  workspace: string): SessionDirectorySource {
  const directory = createCodexSessionDirectory(provider, [{ id: workspace, path: workspace, name: workspace }], provider.readSessionHistory ? new SessionReferenceStore(join(workspace, '.references')) : undefined);
  return { ...directory, async close() { await directory.close(); } };
}
