import { describe, expect, it } from 'vitest';
import { accountAssistants, ASSISTANT_NAME_IDS, ASSISTANT_NAME_WORDS, assistantNamesIn, viewAssistantKey } from './assistant-names.js';
import { ASSISTANT_NAME_VECTORS } from './testing/assistant-names.vectors.js';
import type { WindowGroup } from './window-groups.js';

describe('the names assistants are called by, as the Relay reads them', () => {
  it.each(ASSISTANT_NAME_VECTORS)('$name', ({ assistants, names, locale }) => {
    const called = assistantNamesIn(assistants, locale ?? 'en');
    expect(assistants.map(assistant => called.get(assistant.key))).toEqual(names);
  });

  it('has twenty-five names, each different in English and in Chinese', () => {
    expect(ASSISTANT_NAME_IDS).toHaveLength(25);
    for (const locale of ['en', 'zh'] as const) expect(new Set(ASSISTANT_NAME_IDS.map(id => ASSISTANT_NAME_WORDS[id][locale])).size).toBe(25);
  });

  it('lists every bot view of every group as an assistant, keyed by its group and view, with the name its details store', () => {
    const view = (id: string, nativeSessionId: string, extra = {}) => ({ id, placement: 'primary' as const, binding: { hostId: 'h', providerId: 'codex', nativeSessionId, title: nativeSessionId }, ...extra });
    const groups = [
      { window: { id: 'g1', title: 'Team', revision: 1, views: [view('v1', 's1'), view('ask', 's2', { feature: { kind: 'ask' } })] }, bots: { rank: 'm', members: { v1: { name: 'Chief' } } } },
      { window: { id: 'g2', title: 'Solo', revision: 1, views: [view('v2', 's3')] } },
    ] as unknown as WindowGroup[];
    expect(accountAssistants(groups)).toEqual([{ key: viewAssistantKey('g1', 'v1'), name: 'Chief' }, { key: 'g2/v2' }]);
  });
});
