import {createManagedStdioDirectory, type ManagedStdioProvider} from './stdio-directory.js';
import type {AgentHostWorkspace} from './host.js';
import type {NativeOwnerDiagnostic} from './native-session-owner.js';
import type {SessionReferenceStore} from './session-reference.js';

export function createClaudeSessionDirectory(provider: ManagedStdioProvider, workspaces: readonly AgentHostWorkspace[],
 ownership?: {root: string; onDiagnostic?: (event: NativeOwnerDiagnostic) => void}, references?: SessionReferenceStore) {
 return createManagedStdioDirectory('claude', 'Claude', provider, workspaces, ownership, references);
}
