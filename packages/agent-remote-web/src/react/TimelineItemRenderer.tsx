import type { AgentTimelineItem } from '@borgee/agent-remote-protocol';

import type { MessageGroupPosition } from './timeline-render-model.js';
import { AssistantMessageItem, UserMessageItem } from './items/MessageItem.js';
import { CompactionItem } from './items/CompactionItem.js';
import { ErrorItem } from './items/ErrorItem.js';
import { InteractionItem } from './items/InteractionItem.js';
import { ReasoningItem } from './items/ReasoningItem.js';
import { TodoItem } from './items/TodoItem.js';
import { ToolCallItem, type SessionLinkResolver } from './items/ToolCallItem.js';

export interface TimelineItemRendererProps {
  readonly item: AgentTimelineItem;
  readonly resolveSessionLink?: SessionLinkResolver;
  readonly messageGroup?: MessageGroupPosition;
}

export function TimelineItemRenderer({ item, messageGroup, resolveSessionLink }: TimelineItemRendererProps) {
  switch (item.type) {
    case 'user_message': return <UserMessageItem item={item} messageGroup={messageGroup} />;
    case 'assistant_message': return <AssistantMessageItem item={item} messageGroup={messageGroup} />;
    case 'reasoning': return <ReasoningItem item={item} />;
    case 'tool_call': return <ToolCallItem item={item} resolveSessionLink={resolveSessionLink} />;
    case 'todo': return <TodoItem item={item} />;
    case 'interaction': return <InteractionItem item={item} />;
    case 'error': return <ErrorItem item={item} />;
    case 'compaction': return <CompactionItem item={item} />;
  }
}
