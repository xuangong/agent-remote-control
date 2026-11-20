import { describe, expect, it } from 'vitest';
import { RemoteOperationError } from '../client/transport.js';
import { sessionActivityLabel, sessionNoticeWords } from '../client/session-presentation.js';
import { describe as describeSend } from '../replica/send-state.js';
import { errorWords, storedWords, withMessageKey } from './error-words.js';
import { translator } from './messages.js';

const zh = translator('zh');
const en = translator('en');

describe('words of an error the client made', () => {
  it('uses the catalogue key of a keyed error and its English message without a translator', () => {
    const error = new RemoteOperationError('connection_not_ready', 'Wait for the session to reconnect, then retry.', true, undefined, 'client.error.reconnectRetry');
    expect(errorWords(error, en)).toBe('Wait for the session to reconnect, then retry.');
    expect(errorWords(error, zh)).toBe('等会话重新连上再试。');
  });

  it('fills the params of a keyed error', () => {
    const error = withMessageKey(new Error('Preview request failed (502). Check that preview tunneling is enabled for this Host.'), 'client.error.previewRequestFailed', { status: 502 });
    expect(errorWords(error, zh)).toBe('预览请求失败了（502）。请确认这台 Host 已开启预览隧道。');
  });

  it('finds a stored English message again and leaves what the Relay sent as sent', () => {
    expect(storedWords('Delivery is not confirmed. Check the conversation before sending again.', zh)).toBe('没能确认送达。再发之前先看看对话里有没有。');
    expect(storedWords('Controller said no.', zh)).toBe('Controller said no.');
    expect(errorWords(new Error('Controller said no.'), zh)).toBe('Controller said no.');
  });
});

describe('session words in Chinese', () => {
  it('says a notice, an activity label and a send state in the locale', () => {
    expect(sessionNoticeWords({ kind: 'host_offline', hostName: 'Mac mini' }, zh)).toBe('Mac mini 离线了，回来后消息会送达～');
    expect(sessionNoticeWords({ kind: 'agent_unavailable', message: 'The agent is not available on Mac mini.' }, zh)).toBe('Mac mini 上的 Agent 暂时用不了。');
    expect(sessionNoticeWords({ kind: 'failed', message: 'boom' }, zh)).toBe('boom');
    const facts = { session: { activity: 'running', connection: 'ready', control: undefined, operations: { send_message: { allowed: true } } } } as unknown as Parameters<typeof sessionActivityLabel>[0];
    expect(sessionActivityLabel(facts, false, zh)).toBe('在忙');
    expect(describeSend('sending', undefined, zh).label).toBe('正在发送…');
  });
});
