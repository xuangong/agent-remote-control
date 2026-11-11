import { createContext } from 'react';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import type { SessionViewOperationScope } from '@orchardworks/agent-remote-web/react';
import type { NativeSessionRef, SuccessionActionResult } from '@orchardworks/agent-remote-protocol';
import type { SessionSuccessionDirectory } from './session-succession-directory.js';
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
  successionContextFor?(viewId?: string): { operationId: string; target: NativeSessionRef } | undefined;
  /** Reads the current locators again, for a view that has waited too long for them. */
  synchronize?(): void;
}
/** Succession discovery is (re)reading the current locators; a view may keep the target it last resolved until it finishes. */
export class SessionLocatorSynchronizingError extends Error {
  /** `stale`: the locator was restored from the last confirmed discovery because the Relay could not be reached; views keep showing it while input waits. */
  constructor(readonly stale = false) { super('The current session locator is still synchronizing.'); this.name = 'SessionLocatorSynchronizingError'; }
}
export const SessionViewOperationsContext = createContext<SessionViewOperations | undefined>(undefined);
