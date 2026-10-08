import type { AgentReplicaState } from '@orchardworks/agent-remote-web';
import type { AgentChildSessionView, CommunicationNavigation, SessionLinkResolver } from '@orchardworks/agent-remote-web/react';
import type { OpenedSession } from './directory-client.js';
import { controllerPath } from '@orchardworks/agent-remote-hosted/controller-location';
import { sessionChildren, sessionKey, sessionRootKey, type SessionEntry } from './session-tree.js';
import type { TraceEntryRequest } from './trace-model.js';

export interface SessionViewNavigation {
  childrenFor(nativeSessionId: string): readonly AgentChildSessionView[];
  resolveSessionLink: SessionLinkResolver;
  onOpenChildSession?: (child: AgentChildSessionView) => Promise<void>;
  communication?: CommunicationNavigation;
  revealEntry?: TraceEntryRequest;
}

export type SessionViewNavigationFactory = (source: OpenedSession, state?: AgentReplicaState) => SessionViewNavigation;

/** Native relationships belong to the displayed session, regardless of its container. */
export function sessionViewNavigation({ source, state, entries, openSession, openChildSession, communication, revealEntry }: {
  source: OpenedSession; state?: AgentReplicaState; entries: readonly SessionEntry[];
  openSession?: (target: SessionEntry) => Promise<boolean>;
  openChildSession?: (child: AgentChildSessionView) => Promise<void>;
  communication?: CommunicationNavigation; revealEntry?: TraceEntryRequest;
}): SessionViewNavigation {
  const family = new Map(entries.map(entry => [sessionKey(entry), entry]));
  const origin = { ...family.get(sessionKey(source)), ...source };
  family.set(sessionKey(source), origin);
  for (const child of state?.agent?.runtimeInfo.childSessions ?? []) {
    const target = { ...child, providerId: source.providerId, hostId: source.hostId,
      parentAgentId: source.agentId, parentNativeSessionId: source.nativeSessionId };
    family.set(sessionKey(target), { ...family.get(sessionKey(target)), ...target });
  }
  const known = [...family.values()];
  return {
    childrenFor: nativeSessionId => sessionChildren({ ...source, nativeSessionId }, known),
    resolveSessionLink: nativeSessionId => {
      if (!openSession) return undefined;
      const target = family.get(sessionKey({ ...source, nativeSessionId }));
      if (!target || sessionRootKey(target, known) !== sessionRootKey(origin, known)) return undefined;
      return { title: target.title, href: controllerPath({ ...target, hostId: target.hostId ?? 'local' }), open: async () => {
        if (!await openSession(target)) throw new Error('This session could not be opened.');
      } };
    },
    onOpenChildSession: openChildSession, communication, revealEntry,
  };
}
