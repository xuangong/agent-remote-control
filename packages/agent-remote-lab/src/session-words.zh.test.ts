import { describe, expect, it } from 'vitest';
import { errorWords, translator } from '@orchardworks/agent-client';
import { removalMessage } from './features/chats/bot-removal.js';
import { activityGroups, activityGroupLabel } from './kernel/session-activity-status.js';
import { sessionStatusLabel } from './kernel/session-tree.js';
import { creationUnavailableReason } from './features/sessions/creation-choice.js';
import { createCompositionView } from './kernel/composition-views.js';

const zh = translator('zh');

describe('session words in Chinese', () => {
  it('words what closes with a removed assistant', () => {
    expect(removalMessage(undefined, zh)).toBe('它的会话会继续运行。');
    expect(removalMessage({ asks: 2, bots: ['Edge cases'] }, zh)).toBe('它的会话会继续运行。“Edge cases”和2 个 Ask 会一起关闭。');
  });

  it('words status groups and session states', () => {
    expect(activityGroupLabel(activityGroups[0]!, zh)).toBe('在忙');
    expect(sessionStatusLabel({ providerId: 'p', nativeSessionId: 'n', title: 't', status: 'idle' }, zh)).toBe('空闲');
  });

  it('words why a session cannot be created yet', () => {
    expect(creationUnavailableReason({ selectedHostId: 'h', hosts: [], hostsLoaded: false, providerId: '', reserved: false } as never, zh)).toBe('正在加载 Host…');
  });

  it('words an error with its catalogue key', () => {
    const document = { windows: Array.from({ length: 64 }, (_, index) => ({ id: `v${index}` })), slots: [], editRevision: 0 } as never;
    let thrown: unknown;
    try { createCompositionView(document); } catch (error) { thrown = error; }
    expect(errorWords(thrown, zh)).toMatch(/^要再多开，请先关掉一个会话视图/);
  });
});
