import { describe, expect, it } from 'vitest';
import { buildView, buildWindow } from '../test/window-builders.js';
import { mockScope, renderHook } from '../test/render-hook.js';
import { useAskActivity } from './useAskActivity.js';

const slot = (id: string, agentId?: string) => ({ id, intent: { kind: 'session', target: { hostId: 'local', native: { providerId: 'codex', nativeSessionId: id } } }, metadata: { title: id, ...(agentId ? { agentId } : {}) } });
const document = { slots: [slot('s1', 'agent-s1'), slot('s2'), slot('s3', 'agent-s3')], asks: [{ id: 'o1', sourceSlot: 's1' }, { id: 'o2', sourceSlot: 's2' }, { id: 'o3', sourceSlot: 's3' }], editRevision: 1 };
const askView = buildView('ask');

interface AskFacts { target?: { agentId: string }; attached?: boolean; enabled?: boolean; open?: boolean }

function scopeOf(byOwner: Record<string, AskFacts>, facts: Record<string, unknown> = {}) {
  return mockScope<typeof useAskActivity>({
    ask: { revision: 0, entryFor: (_source: unknown, owner: string) => ({ record: { target: byOwner[owner]?.target }, attached: byOwner[owner]?.attached }),
      isEnabled: (_source: unknown, owner: string) => byOwner[owner]?.enabled ?? true, isOpen: (_source: unknown, owner: string) => byOwner[owner]?.open ?? false, sharedView: () => askView },
    askWindowsVisible: true, compactLayout: false, sharedWindow: buildWindow([askView]), succession: { document }, ...facts,
  });
}

describe('the sessions that have an Ask', () => {
  it('are the sources of the Asks whose slot holds a session', async () => {
    const { result } = await renderHook(() => useAskActivity(scopeOf({})));
    expect(result.current.askSources.map(({ owner, source }) => [owner, source.agentId])).toEqual([['o1', 'agent-s1'], ['o3', 'agent-s3']]);
  });
});

describe('the Asks to watch', () => {
  it('are the enabled Asks with a target conversation, shown when expanded and live when attached', async () => {
    const { result } = await renderHook(() => useAskActivity(scopeOf({
      o1: { target: { agentId: 'ask-1' }, attached: true, open: true }, o3: { target: { agentId: 'ask-3' }, open: false } })));
    expect(result.current.askActivitySessions).toEqual([
      { session: { agentId: 'ask-1' }, visible: true, liveAgentId: 'ask-1' },
      { session: { agentId: 'ask-3' }, visible: false, liveAgentId: undefined },
    ]);
  });
  it('leave out a disabled Ask and one without a target', async () => {
    const { result } = await renderHook(() => useAskActivity(scopeOf({ o1: { target: { agentId: 'ask-1' }, enabled: false }, o3: {} })));
    expect(result.current.askActivitySessions).toEqual([]);
  });
  it('hide an expanded Ask while the global Ask surface is hidden', async () => {
    const { result } = await renderHook(() => useAskActivity(scopeOf({ o1: { target: { agentId: 'ask-1' }, attached: true, open: true } }, { askWindowsVisible: false })));
    expect(result.current.askActivitySessions[0]?.visible).toBe(false);
  });
});
