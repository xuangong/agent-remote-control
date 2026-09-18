import { TimelineTitle } from '../TimelineTitle.js';
import type { AgentTimelineItem } from '@agent-remote-controller/agent-remote-protocol';
import { MarkdownContent } from '../MarkdownContent.js';
import type { MessageGroupPosition } from '../timeline-render-model.js';
import type { MarkdownResourceContext } from '../markdown-resources.js';

type Message = Extract<AgentTimelineItem, { type: 'user_message' | 'assistant_message' }>;

interface MessageItemProps<T extends Message> {
  readonly item: T;
  readonly messageGroup?: MessageGroupPosition;
  readonly resourceContext?: MarkdownResourceContext;
}

export function UserMessageItem({ item, messageGroup, resourceContext }: MessageItemProps<Extract<Message, { type: 'user_message' }>>) {
  return <MessageBubble item={item} messageGroup={messageGroup} resourceContext={resourceContext} />;
}

export function AssistantMessageItem({ item, messageGroup, resourceContext }: MessageItemProps<Extract<Message, { type: 'assistant_message' }>>) {
  return <MessageBubble item={item} messageGroup={messageGroup} resourceContext={resourceContext} />;
}

export function MessageItem({ item }: { readonly item: Message }) {
  return item.type === 'user_message'
    ? <UserMessageItem item={item} />
    : <AssistantMessageItem item={item} />;
}

function MessageBubble({ item, messageGroup = 'single', resourceContext }: MessageItemProps<Message>) {
  const user = item.type === 'user_message';
  return <article
    className={`agent-timeline-item agent-message agent-message-${user ? 'user' : 'assistant'} agent-message-group-${messageGroup}`}
    aria-label={user ? 'User message' : 'Assistant message'}
    data-message-group={messageGroup}
  >
    <header className="agent-item-header">
      <TimelineTitle className="agent-item-kicker">{user ? 'You' : 'Assistant'}</TimelineTitle>
    </header>
    <MarkdownContent markdown={item.text} resourceContext={resourceContext} />
  </article>;
}
