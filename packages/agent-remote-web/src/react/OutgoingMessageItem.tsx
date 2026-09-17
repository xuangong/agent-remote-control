import type { OutgoingMessage } from '../replica/types.js';
import { UserMessageItem } from './items/MessageItem.js';

export function OutgoingMessageItem({ message }: { readonly message: OutgoingMessage }) {
  const settled = message.status === 'failed' || message.status === 'unconfirmed';
  const label = message.status === 'failed' ? 'Send failed — not confirmed'
    : message.status === 'unconfirmed' ? 'Send acknowledged — conversation not confirmed'
    : message.status === 'sending' ? 'Sending…'
    : message.delivery === 'next_turn' ? 'Queued — waiting for conversation…' : 'Sent — waiting for conversation…';
  return <div className="agent-timeline-entry agent-outgoing-message" data-entry-key={message.id}
    data-delivery-state={settled ? message.status : 'pending'} aria-busy={!settled}>
    <UserMessageItem item={{ type: 'user_message', text: message.text }} />
    <p className="agent-message-delivery" role={message.status === 'failed' ? 'alert' : 'status'}>
      <span className="agent-delivery-dot" aria-hidden="true" />
      <span>{label}{settled ? ' · Disappears in 10 seconds.' : ''}</span>
      {settled && message.error ? <span className="agent-delivery-error">{message.error}</span> : null}
    </p>
  </div>;
}
