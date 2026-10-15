import { createContext } from 'react';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import type { SessionViewOperationScope } from '@orchardworks/agent-remote-web/react';
import type { SuccessionActionResult } from '@orchardworks/agent-remote-protocol';
import type { SessionSuccessionDirectory } from './components/SessionSuccessionDialog.js';
import type { OpenedSession } from './directory-client.js';
import type { SessionEntry } from './session-tree.js';

export interface SessionOperationBinding { source: OpenedSession; scope?: SessionViewOperationScope; historical?: boolean }
export interface FollowingTarget { target: SessionEntry; historyRoleId?: string }
/** Embedders own directory, recovery and navigation; the renderer owns its acquired client. */
export interface SessionViewOperations {
  storageScope: string; transport: RemoteAgentTransport; enabled: boolean;
  resolveTarget(source: SessionEntry, options?: { nativePrefixOnly?: boolean; viewId?: string }): FollowingTarget;
  directory(source: OpenedSession): SessionSuccessionDirectory;
  refreshSettled(result: SuccessionActionResult, source: OpenedSession): Promise<void>;
}
export const SessionViewOperationsContext = createContext<SessionViewOperations | undefined>(undefined);
