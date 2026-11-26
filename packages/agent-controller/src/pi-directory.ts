import {createManagedStdioDirectory, type ManagedStdioProvider} from './stdio-directory.js';
import type {AgentHostWorkspace} from './host.js';
import type {SessionReferenceStore} from './session-reference.js';

/** pi has no native lock and saves a session only with its first message, so the directory has no ownership lease and no creation store. */
export function createPiSessionDirectory(provider: ManagedStdioProvider, workspaces: readonly AgentHostWorkspace[], references?: SessionReferenceStore) {
 return createManagedStdioDirectory('pi', 'pi', provider, workspaces, undefined, references);
}
