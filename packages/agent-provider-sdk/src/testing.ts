import type { AgentPersistenceHandle, AgentSession, ProviderObservation, ProviderStreamItem } from './index.js';
import { describe, expect, it } from 'vitest';

import type { AgentProviderAdapter, AgentSessionConfig } from './index.js';

export interface CollectedProviderStream {
  history: ProviderObservation[];
  live: ProviderObservation[];
  boundary: Extract<ProviderStreamItem, { type: 'history_boundary' }>;
}

export async function collectProviderStream(
  session: AgentSession,
  liveCount: number,
): Promise<CollectedProviderStream> {
  const history: ProviderObservation[] = [];
  const live: ProviderObservation[] = [];
  let boundary: CollectedProviderStream['boundary'] | undefined;

  for await (const item of session.observe()) {
    if (item.type === 'history_boundary') {
      if (boundary) throw new Error('Provider emitted more than one history boundary.');
      boundary = item;
      if (liveCount === 0) break;
      continue;
    }
    if (!boundary) {
      if (item.delivery !== 'history') throw new Error('Provider emitted live data before the history boundary.');
      history.push(item);
      continue;
    }
    if (item.delivery !== 'live') throw new Error('Provider emitted history data after the history boundary.');
    live.push(item);
    if (live.length === liveCount) break;
  }

  if (!boundary) throw new Error('Provider did not emit a history boundary.');
  if (live.length < liveCount) {
    throw new Error(`Provider stream ended before ${liveCount} live observation was collected.`);
  }
  return { history, live, boundary };
}

export function validateAgentSessionCapabilities(session: AgentSession): void {
  const checks: Array<[enabled: boolean, method: keyof AgentSession, label: string]> = [
    [session.capabilities.sendMessage, 'sendMessage', 'sendMessage'],
    [session.capabilities.steer, 'steer', 'steer'],
    [session.capabilities.cancel, 'cancel', 'cancel'],
    [session.capabilities.sessionSettings === true, 'setSessionSetting', 'setSessionSetting'],
    [session.capabilities.commands === true, 'listCommands', 'listCommands'],
    [session.capabilities.commands === true, 'executeCommand', 'executeCommand'],
    [session.capabilities.planning === true, 'setPlanning', 'setPlanning'],
    [session.capabilities.readResource, 'readResource', 'readResource'],
    [
      Object.values(session.capabilities.interactions).some(Boolean),
      'respondToInteraction',
      'respondToInteraction',
    ],
  ];
  for (const [enabled, method, label] of checks) {
    if (enabled && typeof session[method] !== 'function') {
      throw new Error(`Provider declares ${label} support but does not implement ${label}().`);
    }
  }
}

export interface AgentProviderContractFixture {
  adapter: AgentProviderAdapter;
  createConfig: AgentSessionConfig;
  expected: {
    providerId: string;
    historyCount: number;
    liveCount: number;
  };
}

export function runAgentProviderContractTests(
  name: string,
  factory: () => Promise<AgentProviderContractFixture>,
): void {
  describe(name, () => {
    it('creates a session with a valid capability surface and one history boundary', async () => {
      const fixture = await factory();
      expect(fixture.adapter.descriptor.providerId).toBe(fixture.expected.providerId);
      const created = await fixture.adapter.createSession(fixture.createConfig);
      try {
        validateAgentSessionCapabilities(created);
        const runtime = await created.runtimeInfo();
        expect(runtime.providerId).toBe(fixture.expected.providerId);
        expect(runtime.sessionId).toBe(fixture.createConfig.sessionId);
        if (!runtime.persistence) throw new Error('Created Provider session did not expose a persistence handle.');
        expect(runtime.persistence.providerId).toBe(runtime.providerId);
        expect(runtime.persistence.sessionId).toBe(runtime.sessionId);
        const stream = await collectProviderStream(created, fixture.expected.liveCount);
        expect(stream.history).toHaveLength(fixture.expected.historyCount);
        expect(stream.live).toHaveLength(fixture.expected.liveCount);
      } finally {
        await created.dispose();
      }
    });

    it('resumes the same Provider session identity and disposes both owned sessions', async () => {
      const fixture = await factory();
      const created = await fixture.adapter.createSession(fixture.createConfig);
      let persistence: AgentPersistenceHandle;
      try {
        const runtime = await created.runtimeInfo();
        if (!runtime.persistence) throw new Error('Created Provider session did not expose a persistence handle.');
        persistence = runtime.persistence;
      } finally {
        await created.dispose();
      }

      const resumed = await fixture.adapter.resumeSession(persistence);
      try {
        validateAgentSessionCapabilities(resumed);
        const runtime = await resumed.runtimeInfo();
        expect(runtime.providerId).toBe(persistence.providerId);
        expect(runtime.sessionId).toBe(persistence.sessionId);
        expect(runtime.persistence).toEqual(persistence);
        const stream = await collectProviderStream(resumed, fixture.expected.liveCount);
        expect(stream.history).toHaveLength(fixture.expected.historyCount);
        expect(stream.live).toHaveLength(fixture.expected.liveCount);
      } finally {
        await resumed.dispose();
      }
    });
  });
}
