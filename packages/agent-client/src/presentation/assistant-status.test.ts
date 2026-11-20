import { describe, expect, it } from 'vitest';
import { SESSION_CONNECTION_PATTERN } from '../testing/connection-words.js';
import type { SessionNotice } from '../client/session-presentation.js';
import { assistantStatus, type AssistantFacts } from './assistant-status.js';
import { ASSISTANT_STATUS_VECTORS } from './assistant-status.vectors.js';
import { translator } from './messages.js';

const en = translator('en'), zh = translator('zh');
const facts = (partial: Partial<AssistantFacts>): AssistantFacts => ({ activity: 'idle', asleep: false, waitingToSend: false, ...partial });

describe('assistantStatus', () => {
  it.each(ASSISTANT_STATUS_VECTORS)('$name', ({ facts: partial, state, sentence, mood }) => {
    expect(assistantStatus(facts(partial))).toEqual({ state, sentence, mood });
  });

  it('says the design\'s Chinese for each state', () => {
    const say = (partial: Partial<AssistantFacts>) => assistantStatus(facts(partial), zh).sentence;
    expect(say({ activity: 'waiting' })).toBe('想问你一件小事');
    expect(say({ host: { online: false, name: 'Mac mini' } })).toBe('Mac mini 离线，消息会在它上线后送达');
    expect(say({ host: { online: false } })).toBe('电脑离线了，消息会在它上线后送达');
    expect(say({ activity: 'failed' })).toBe('出了点问题');
    expect(say({ activity: 'closed' })).toBe('这段对话已经结束了');
    expect(say({ asleep: true })).toBe('在休息，需要时自动醒来');
    expect(say({ activity: 'running' })).toBe('在忙，稍等～');
    expect(say({ waitingToSend: true })).toBe('等它准备好就发出去');
    expect(say({})).toBe('有事随时叫我');
    expect(say({ replyPreview: '好了' })).toBe('好了');
  });

  describe('A-1: no connection words, and an unknown or offline activity alone is never an activity', () => {
    const activities = ['starting', 'idle', 'running', 'waiting', 'failed', 'closed', 'unknown', 'offline'] as const;
    const hosts = [undefined, { online: true, name: 'Mac mini' }, { online: false, name: 'Mac mini' }, { online: false }] as const;
    const notices: readonly (SessionNotice | undefined)[] = [
      undefined, { kind: 'host_offline', hostName: 'Mac mini' }, { kind: 'host_offline' }, { kind: 'ended' }, { kind: 'failed', message: 'Reconnecting' },
      { kind: 'terminal_in_control' }, { kind: 'other_controller' }, { kind: 'read_only' }, { kind: 'unavailable', message: 'Reconnect' }, { kind: 'agent_unavailable', message: 'x' },
    ];
    const product: AssistantFacts[] = [];
    for (const activity of activities) for (const host of hosts) for (const notice of notices) for (const asleep of [false, true]) for (const waitingToSend of [false, true]) {
      product.push({ activity, asleep, waitingToSend, ...(host ? { host } : {}), ...(notice ? { notice } : {}) });
    }

    it('speaks no connection word in either language', () => {
      expect(product.length).toBe(8 * 4 * 10 * 4);
      const offenders = product.flatMap(row => [en, zh].map(t => assistantStatus(row, t).sentence)).filter(sentence => SESSION_CONNECTION_PATTERN.test(sentence));
      expect(offenders).toEqual([]);
    });

    it.each(['unknown', 'offline'] as const)('%s alone is unknown or host_offline', activity => {
      expect(['unknown', 'host_offline']).toContain(assistantStatus(facts({ activity })).state);
    });
  });
});
