import type { AgentTimelineItem } from '@borgee/agent-remote-protocol';
import { MarkdownContent } from '../MarkdownContent.js';
import type { MessageGroupPosition } from '../timeline-render-model.js';

type Message = Extract<AgentTimelineItem, { type: 'user_message' | 'assistant_message' }>;

interface MessageItemProps<T extends Message> {
  readonly item: T;
  readonly messageGroup?: MessageGroupPosition;
}

export function UserMessageItem({ item, messageGroup }: MessageItemProps<Extract<Message, { type: 'user_message' }>>) {
  return <MessageBubble item={item} messageGroup={messageGroup} />;
}

export function AssistantMessageItem({ item, messageGroup }: MessageItemProps<Extract<Message, { type: 'assistant_message' }>>) {
  return <MessageBubble item={item} messageGroup={messageGroup} />;
}

export function MessageItem({ item }: { readonly item: Message }) {
  return item.type === 'user_message'
    ? <UserMessageItem item={item} />
    : <AssistantMessageItem item={item} />;
}

function MessageBubble({ item, messageGroup = 'single' }: MessageItemProps<Message>) {
  const user = item.type === 'user_message';
  return <article
    className={`agent-timeline-item agent-message agent-message-${user ? 'user' : 'assistant'} agent-message-group-${messageGroup}`}
    aria-label={user ? 'User message' : 'Assistant message'}
    data-message-group={messageGroup}
  >
    <header className="agent-item-header">
      <span className="agent-item-kicker">{user ? 'You' : 'Assistant'}</span>
    </header>
    <MarkdownContent markdown={item.text} />
  </article>;
}
