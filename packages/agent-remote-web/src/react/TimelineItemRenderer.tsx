import type { ResourceResponseState } from '@orchardworks/agent-remote-protocol';
import type { AgentTimelineItem, ResourceBinding } from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState } from '../replica/types.js';
import { memo, useMemo } from 'react';

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
  readonly resources?: AgentReplicaState['resources'];
  readonly resourceBindings?: readonly ResourceBinding[];
  readonly resourceScopeKey?: string;
  readonly onResourceResolve?: (locator: string, sourceLocator?: string) => Promise<ResourceBinding>;
  readonly onResourceRequest?: (binding: ResourceBinding) => Promise<void | ResourceResponseState>;
}

export const TimelineItemRenderer = memo(function TimelineItemRenderer({ item, messageGroup, resolveSessionLink, resources, resourceBindings, resourceScopeKey, onResourceResolve, onResourceRequest }: TimelineItemRendererProps) {
  const markdownResources = useMemo(() => (
    resources && resourceBindings && resourceScopeKey && onResourceResolve && onResourceRequest
      ? { scopeKey: resourceScopeKey, resources, bindings: resourceBindings, resolveResource: onResourceResolve, requestResource: onResourceRequest }
      : undefined
  ), [onResourceRequest, onResourceResolve, resourceBindings, resourceScopeKey, resources]);
  switch (item.type) {
    case 'user_message': return <UserMessageItem item={item} messageGroup={messageGroup} resourceContext={markdownResources} />;
    case 'assistant_message': return <AssistantMessageItem item={item} messageGroup={messageGroup} resourceContext={markdownResources} />;
    case 'reasoning': return <ReasoningItem item={item} />;
    case 'tool_call': return <ToolCallItem item={item} resolveSessionLink={resolveSessionLink} />;
    case 'todo': return <TodoItem item={item} />;
    case 'interaction': return <InteractionItem item={item} />;
    case 'error': return <ErrorItem item={item} />;
    case 'compaction': return <CompactionItem item={item} />;
  }
});
