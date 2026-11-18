import type { HostSessionState } from '@orchardworks/agent-remote-protocol';
import { AgentRuntimeError, type AgentProviderAdapter } from '@orchardworks/agent-provider-sdk';
import type { RemoteHostCatalog, RemoteSessionSummary, HandoffAdmissionState } from '@orchardworks/agent-session-runtime';

import { liveSessionState } from '../session-state-publisher.js';
import type { SessionCallerCatalog } from '../session-callers.js';
import type { AgentHostDirectory } from './types.js';

/**
 * Catalog: the sessions of this Host as the pages, the Relay and the session commands read them.
 *
 * Contract.
 * - `catalogSessionStates` turns listing summaries into the session states the Relay shares: `unavailable` becomes `failed`, a state that is
 *   unknown is left out, and an update time that is not a valid non-negative instant is left out of its row.
 * - A disabled provider has no sessions, no summary and no history; its identity is not listed.
 * - A session's summary comes from its directory's own read when it has one, else from the catalog.
 * - `liveState` is the state of the session's runtime now, or nothing while it has no runtime.
 *
 * Mutable state: none; the registrations, catalogs and runtimes are ports.
 */
export function catalogSessionStates(summaries: readonly RemoteSessionSummary[]): HostSessionState[] {
  return summaries.flatMap(summary => {
    const state = summary.state === 'unavailable' ? 'failed' : summary.state === 'unknown' ? undefined : summary.state;
    const updatedAt = Date.parse(summary.updatedAt);
    return state ? [{ providerId: summary.providerId, nativeSessionId: summary.nativeSessionId, state, ...(Number.isFinite(updatedAt) && updatedAt >= 0 ? { updatedAt } : {}) }] : [];
  });
}

export interface SessionCatalogPorts {
  providerIds(): Iterable<string>;
  enabled(providerId: string): boolean;
  catalog(providerId: string): Pick<RemoteHostCatalog, 'page' | 'session'> | undefined;
  directory(providerId: string): Pick<AgentHostDirectory, 'sessionSummary'> | undefined;
  /** Throws a request error for a provider this Host does not have. */
  adapter(providerId: string): Pick<AgentProviderAdapter, 'readSessionHistory'>;
  /** The handoff admission state of the session's runtime, when it has one. */
  runtimeState(providerId: string, nativeSessionId: string): HandoffAdmissionState | undefined;
}

const PAGE_SIZE = 100;

export function createSessionCatalog(ports: SessionCatalogPorts): SessionCallerCatalog {
  return {
    providers: () => [...ports.providerIds()].filter(ports.enabled),
    async sessions(providerId) {
      const catalog = ports.catalog(providerId);
      if (!catalog || !ports.enabled(providerId)) return [];
      const sessions: RemoteSessionSummary[] = [];
      let cursor: string | undefined;
      do {
        const page = await catalog.page({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
        sessions.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return sessions;
    },
    async session(ref) {
      if (!ports.enabled(ref.providerId)) return undefined;
      const directory = ports.directory(ref.providerId);
      return directory?.sessionSummary ? directory.sessionSummary(ref.nativeSessionId) : ports.catalog(ref.providerId)?.session(ref.nativeSessionId);
    },
    async history(ref, query) {
      if (!ports.enabled(ref.providerId)) throw new AgentRuntimeError('native_session_unavailable', 'The provider is disabled.');
      const adapter = ports.adapter(ref.providerId);
      if (!adapter.readSessionHistory) throw new Error('Native history is unavailable for this provider.');
      return adapter.readSessionHistory(ref.nativeSessionId, query);
    },
    liveState(ref) {
      const state = ports.runtimeState(ref.providerId, ref.nativeSessionId);
      return state ? liveSessionState(state) : undefined;
    },
  };
}
