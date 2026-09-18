import type { AgentReplica, OutgoingMessage } from '@agent-remote-controller/agent-remote-web';

export function recoverMessages(replica: AgentReplica, relay: string, session: string, agentId: string): () => void {
  const key = `agent-remote:recovery:${relay}:outbox:${session}`;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(value)) replica.restoreMessages(value.filter(validMessage).map(message => ({ ...message, agentId })));
  } catch { /* Stored feedback must not prevent conversation recovery. */ }
  let previous = replica.getState().outgoingMessages;
  return replica.subscribe(() => {
    const messages = replica.getState().outgoingMessages;
    if (messages === previous) return;
    previous = messages;
    try {
      if (messages?.length) localStorage.setItem(key, JSON.stringify(messages));
      else localStorage.removeItem(key);
    } catch { /* Feedback remains in memory if browser storage is unavailable or full. */ }
  });
}

function validMessage(value: unknown): value is OutgoingMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as OutgoingMessage;
  return typeof message.id === 'string' && typeof message.text === 'string'
    && (message.epoch === null || typeof message.epoch === 'string') && Number.isSafeInteger(message.afterSeq)
    && ['sending', 'awaiting_echo', 'unconfirmed', 'failed'].includes(message.status)
    && (message.retryRequiresNewOperation === undefined || typeof message.retryRequiresNewOperation === 'boolean')
    && (message.operationId === undefined || typeof message.operationId === 'string')
    && (message.delivery === undefined || ['immediate', 'next_turn'].includes(message.delivery))
    && (message.error === undefined || typeof message.error === 'string');
}
