import type { ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { describe, expect, it } from 'vitest';

import { createRecordedDshProvider } from './recorded-provider.js';
import type { DshTrace } from './trace/schema.js';

const trace: DshTrace = {
  header: {
    type: 'trace_header', format: 'borgee.dsh.trace.v1', sessionId: 'recorded-session',
    nativeSessionHeader: {}, runtimeInfo: { status: 'waiting', cwd: '/workspace', model: { id: 'deepseek-chat' } },
  },
  records: [{
    type: 'native_record', ordinal: 1, offset: 0, recordId: 'user-1', kind: 'session_event',
    payload: {
      type: 'user/message',
      data: { id: 'message-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Recorded' }] },
    },
  }],
};

describe('recorded DSH Provider', () => {
  it('replays Provider observations after one history boundary', async () => {
    const session = await createRecordedDshProvider({ trace, mode: { kind: 'immediate' } })
      .createSession({ sessionId: 'recorded-session' });
    const items: ProviderStreamItem[] = [];
    for await (const item of session.observe()) items.push(item);

    expect(items[0]).toEqual({ type: 'history_boundary' });
    expect(items[1]).toMatchObject({
      delivery: 'live',
      event: { type: 'timeline', provider: 'dsh', item: { type: 'user_message', text: 'Recorded' } },
    });
  });

  it('declares every mutation and resource capability unsupported', async () => {
    const session = await createRecordedDshProvider({ trace, mode: { kind: 'immediate' } })
      .createSession({ sessionId: 'recorded-session' });

    expect(session.capabilities).toEqual({
      history: true, sendMessage: false, steer: false, cancel: false, readResource: false,
      interactions: { question: false, planApproval: false, toolApproval: false },
    });
    await expect(session.sendMessage('No')).rejects.toThrow('recorded DSH trace');
    await expect(session.respondToInteraction('missing', { kind: 'question', answers: [] }))
      .rejects.toThrow('recorded DSH trace');
  });

  it('exposes a stable resumable runtime identity', async () => {
    const provider = createRecordedDshProvider({ trace, mode: { kind: 'immediate' } });
    const created = await provider.createSession({ sessionId: 'recorded-session' });
    const runtime = await created.runtimeInfo();
    if (!runtime.persistence) throw new Error('missing persistence');
    const resumed = await provider.resumeSession(runtime.persistence);

    expect(await resumed.runtimeInfo()).toEqual({
      providerId: 'dsh-recorded', sessionId: 'recorded-session', status: 'waiting', cwd: '/workspace',
      model: 'deepseek-chat', persistence: runtime.persistence,
    });
  });
});
