import type { OutgoingMessage } from '../replica/types.js';
import { UserMessageItem } from './items/MessageItem.js';

export function OutgoingMessageItem({ message }: { readonly message: OutgoingMessage }) {
  const failed = message.status === 'failed' || message.status === 'unconfirmed';
  const label = failed ? 'Send failed — not confirmed'
    : message.status === 'sending' ? 'Sending…'
    : message.delivery === 'next_turn' ? 'Queued — waiting for conversation…' : 'Sent — waiting for conversation…';
  return <div className="agent-timeline-entry agent-outgoing-message" data-entry-key={message.id}
    data-delivery-state={failed ? 'failed' : 'pending'} aria-busy={!failed}>
    <UserMessageItem item={{ type: 'user_message', text: message.text }} />
    <p className="agent-message-delivery" role={failed ? 'alert' : 'status'}>
      <span className="agent-delivery-dot" aria-hidden="true" />
      <span>{label}{failed ? ' · Disappears in 10 seconds.' : ''}</span>
      {failed && message.error ? <span className="agent-delivery-error">{message.error}</span> : null}
    </p>
  </div>;
}
