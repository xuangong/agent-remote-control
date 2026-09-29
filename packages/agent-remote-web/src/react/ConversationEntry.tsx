import { memo, type ReactNode } from 'react';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState } from '../replica/types.js';
import type { AgentTimelineProps } from './AgentTimeline.js';
import { TimelineEntry } from './TimelineEntry.js';
import { TimelineItemRenderer } from './TimelineItemRenderer.js';
import { ResourceList } from './ResourceList.js';
import { PreviewActions, type PreviewController } from './PreviewActions.js';
import { isContentOnlyItem, TimelineSearchReveal } from './TimelineDisplay.js';
import type { MessageGroupPosition } from './timeline-render-model.js';

interface ConversationEntryProps extends Pick<AgentTimelineProps, 'onEditPrompt' | 'onInspectEntry' | 'resolveSessionLink'
  | 'onResourceResolve' | 'onResourceRequest'> {
  entry: ProjectedTimelineEntry;
  entryKey: string;
  messageGroup?: MessageGroupPosition;
  contentOnly: boolean;
  agentId?: string;
  scopeKey: string;
  resources: AgentReplicaState['resources'];
  inspected: boolean;
  searchSelected?: boolean;
  previews?: PreviewController;
  extension?: ReactNode;
}

// Unchanged history stays mounted without rebuilding its controls on every delta.
export const ConversationEntry = memo(function ConversationEntry({ entry, entryKey, messageGroup, contentOnly, agentId,
  scopeKey, resources, onEditPrompt, onInspectEntry, inspected, searchSelected, resolveSessionLink, onResourceResolve, onResourceRequest,
  previews, extension }: ConversationEntryProps) {
  return <TimelineSearchReveal.Provider value={!!searchSelected}><TimelineEntry entryKey={entryKey}
    onEdit={onEditPrompt && entry.item.type === 'user_message' && entry.item.messageId && entry.turnId ? () => onEditPrompt(entry) : undefined}
    timestamp={entry.timestamp} sent={entry.item.type === 'user_message'} sequence={entry.seqStart}
    inspected={inspected || !!searchSelected} inspect={!contentOnly && onInspectEntry ? () => onInspectEntry(entryKey) : undefined}>
    <TimelineItemRenderer item={entry.item} messageGroup={messageGroup} resolveSessionLink={resolveSessionLink}
      resources={resources} resourceBindings={entry.resources} resourceScopeKey={scopeKey}
      onResourceResolve={onResourceResolve} onResourceRequest={onResourceRequest} />
    {previews && agentId && entry.item.type !== 'error' && isContentOnlyItem(entry.item) ? <PreviewActions agentId={agentId} itemId={entryKey} text={previewText(entry.item)} controller={previews} /> : null}
    {!contentOnly ? <>
      {extension}
      <ResourceList bindings={entry.resources} resources={resources} onRequest={onResourceRequest} />
    </> : null}
  </TimelineEntry></TimelineSearchReveal.Provider>;
});

function previewText(item: AgentReplicaState['timeline']['entries'][number]['item']): string {
  switch (item.type) {
    case 'agent_communication':
    case 'user_message':
    case 'assistant_message':
    case 'reasoning': return item.text;
    case 'error': return item.message;
    case 'tool_call': return [toolDetailText(item.detail), ...(item.result?.content.map(content => content.type === 'text' ? content.text : JSON.stringify(content.value)) ?? [])].join('\n');
    case 'todo': return item.items.map(task => task.text).join('\n');
    case 'interaction': return JSON.stringify(item.request);
    case 'compaction': return '';
  }
}

function toolDetailText(detail: Extract<AgentReplicaState['timeline']['entries'][number]['item'], { type: 'tool_call' }>['detail']): string {
  switch (detail.type) {
    case 'shell': return detail.command;
    case 'read':
    case 'edit':
    case 'write': return detail.filePath;
    case 'search': return detail.query;
    case 'fetch': return detail.url;
    case 'other': return detail.description;
  }
}
