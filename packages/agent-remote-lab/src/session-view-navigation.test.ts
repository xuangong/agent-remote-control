import { expect, it } from 'vitest';
import { sessionViewNavigation } from './session-view-navigation.js';
import type { SessionEntry } from './session-tree.js';
import { replicaState } from './test/fixtures.js';

const source = { agentId: 'ask-agent', nativeSessionId: 'ask', providerId: 'codex', hostId: 'source-host', title: 'Ask' };

it('keeps colliding native IDs scoped to the displayed Host and Provider', async () => {
  const child = { ...source, agentId: 'child-agent', nativeSessionId: 'child', parentNativeSessionId: 'ask', title: 'Correct child' };
  const opened: SessionEntry[] = [];
  const navigation = sessionViewNavigation({ source, entries: [child,
    { ...child, hostId: 'other-host', title: 'Wrong Host' },
    { ...child, providerId: 'claude', title: 'Wrong Provider' },
  ], openSession: async target => { opened.push(target); return true; } });
  expect(navigation.childrenFor('ask').map(item => item.title)).toEqual(['Correct child']);
  const target = navigation.resolveSessionLink('child')!;
  const url = new URL(target.href, 'https://controller.example');
  expect(url.searchParams.get('host')).toBe('source-host');
  expect(url.searchParams.get('provider')).toBe('codex');
  await target.open();
  expect(opened).toEqual([child]);
});

it('combines live child descriptors with saved descendants without linking unrelated sessions', () => {
  const navigation = sessionViewNavigation({ source, state: { ...replicaState, agent: { ...replicaState.agent!, id: source.agentId,
    runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: source.nativeSessionId,
      childSessions: [{ nativeSessionId: 'child', title: 'Live child', createdAt: '2026-10-08', status: 'running', observation: 'live' }] },
  } }, entries: [
    { ...source, nativeSessionId: 'grandchild', parentNativeSessionId: 'child', title: 'Saved descendant' },
    { ...source, nativeSessionId: 'unrelated', title: 'Unrelated session' },
  ], openSession: async () => true });
  expect(navigation.childrenFor('ask').map(item => item.title)).toEqual(['Live child']);
  expect(navigation.childrenFor('child').map(item => item.title)).toEqual(['Saved descendant']);
  expect(navigation.resolveSessionLink('grandchild')?.title).toBe('Saved descendant');
  expect(navigation.resolveSessionLink('unrelated')).toBeUndefined();
});

it('uses a saved source parent when its opened handle does not carry ancestry', () => {
  const navigation = sessionViewNavigation({ source, entries: [
    { ...source, parentNativeSessionId: 'parent' },
    { ...source, agentId: 'parent-agent', nativeSessionId: 'parent', title: 'Saved parent' },
  ], openSession: async () => true });
  expect(navigation.resolveSessionLink('parent')?.title).toBe('Saved parent');
});
