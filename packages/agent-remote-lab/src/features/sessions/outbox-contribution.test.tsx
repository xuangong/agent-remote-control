import { describe, expect, it, vi } from 'vitest';
import type { Translate } from '@orchardworks/agent-client';
import { buildHost, buildSessionViewContext, elementsOf, firstElement } from '../../test/session-view-context.js';
import { outboxContribution } from './outbox-contribution.js';
import { SessionOutboxMessages } from './OutboxMessages.js';

const t = ((key: string, values?: { host?: string }) => values?.host ? `${key}:${values.host}` : key) as Translate;
const queuing = () => ({ queueMessage: vi.fn(async () => {}), cancelQueuedMessage: vi.fn(async () => {}), retryQueuedMessage: vi.fn(async () => {}) });
const offline = (host = buildHost({ online: false, outbox: 1 }), facts = {}) => buildSessionViewContext({ host, context: { offline: true }, ...facts });

describe('the outbox in a session view', () => {
  it('follows the conversation with the messages waiting for the Host', () => {
    const list = firstElement(outboxContribution({ transport: queuing() as never, t })(buildSessionViewContext()).props?.timelineEnd);
    expect(list.type).toBe(SessionOutboxMessages);
    expect(list.props).toMatchObject({ session: { hostId: 'local', providerId: 'codex', nativeSessionId: 's1' }, hostName: 'Mac', hostOnline: true });
  });

  it('has no list when the transport keeps no outbox', () => {
    expect(outboxContribution({ transport: {} as never, t })(buildSessionViewContext()).props?.timelineEnd).toBeUndefined();
  });

  it('offers to send later and explains the wait when the Host is offline and delivers from its outbox', async () => {
    const transport = queuing();
    const { props, composerNotice } = outboxContribution({ transport: transport as never, t })(offline());
    expect(props).toMatchObject({ loadingNotice: { title: 'sessions.presentation.hostOffline:Mac', detail: 'sessions.presentation.backLater' }, sendLater: { label: 'sessions.presentation.sendWhenBack:Mac' } });
    await props!.sendLater!.send('hello');
    expect(transport.queueMessage).toHaveBeenCalledWith({ hostId: 'local', providerId: 'codex', nativeSessionId: 's1' }, 'hello');
    expect(composerNotice).toBeUndefined();
  });

  it('asks for a Controller update when the Host cannot deliver from its outbox', () => {
    const { props, composerNotice } = outboxContribution({ transport: queuing() as never, t })(offline(buildHost({ online: false })));
    expect(props?.sendLater).toBeUndefined();
    expect(props?.loadingNotice?.detail).toBe('sessions.presentation.back2');
    expect(firstElement(composerNotice).props).toMatchObject({ className: 'agent-composer-note lab-outbox-hint', children: 'sessions.presentation.updateController:Mac' });
  });

  it('keeps the wait for a shared Host, a Side and a historical session', () => {
    for (const view of [offline(buildHost({ online: false, access: 'shared', outbox: 1 })), offline(undefined, { source: { parentNativeSessionId: 'root' } }),
      offline(undefined, { context: { offline: true, operationBinding: { historical: true } } })]) {
      const result = outboxContribution({ transport: queuing() as never, t })(view);
      expect(result.props?.sendLater).toBeUndefined();
      expect(result.composerNotice).toBeUndefined();
    }
  });

  it('says nothing about the Host while it is online', () => {
    expect(outboxContribution({ transport: queuing() as never, t })(buildSessionViewContext()).props?.loadingNotice).toBeUndefined();
  });
});
