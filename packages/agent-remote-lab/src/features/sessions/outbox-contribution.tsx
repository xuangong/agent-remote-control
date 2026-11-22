// What the outbox says about a session view: messages waiting for an offline Host, and the offer to send them when it is back.
import type { RemoteAgentTransport, Translate } from '@orchardworks/agent-client';
import type { SessionViewContribution, SessionViewContext } from '../../conversation/session-view-contribution.js';
import { SessionOutboxMessages } from './OutboxMessages.js';

export interface OutboxContributionInputs {
  transport: Pick<RemoteAgentTransport, 'queueMessage' | 'cancelQueuedMessage' | 'retryQueuedMessage'>;
  t: Translate;
}

export const outboxContribution = ({ transport, t }: OutboxContributionInputs) => (view: SessionViewContext): SessionViewContribution => {
  const { context, source, host } = view;
  // A conversation whose Host is offline can still be written to: the message waits for the Host when its Controller delivers from the outbox.
  const outboxTarget = { hostId: source.hostId, providerId: source.providerId, nativeSessionId: source.nativeSessionId };
  const writable = !!context.offline && !!host && host.access !== 'shared' && !source.parentNativeSessionId && !context.operationBinding.historical;
  const laterHost = writable && host!.outbox === 1 && transport.queueMessage ? host : undefined;
  const outdatedOffline = writable && host!.outbox !== 1 && !!transport.queueMessage;
  return {
    props: {
      // Messages waiting for an offline Host follow the conversation; the timeline's own live line says when the assistant works.
      timelineEnd: transport.cancelQueuedMessage ? <SessionOutboxMessages session={outboxTarget} hostName={host?.name ?? source.hostId} hostOnline={host?.online === true}
        onCancel={async id => { await transport.cancelQueuedMessage!(id); }} onRetry={async id => { await transport.retryQueuedMessage!(id); }} /> : undefined,
      ...(laterHost ? { sendLater: { label: t('sessions.presentation.sendWhenBack', { host: laterHost.name }), send: async (text: string) => { await transport.queueMessage!(outboxTarget, text); } } } : {}),
      ...(context.offline && host ? { loadingNotice: { title: t('sessions.presentation.hostOffline', { host: host.name }),
        detail: laterHost ? t('sessions.presentation.backLater') : t('sessions.presentation.back2') } } : {}),
    },
    composerNotice: outdatedOffline ? <p className="agent-composer-note lab-outbox-hint" role="status">{t('sessions.presentation.updateController', { host: host!.name })}</p> : undefined,
  };
};
