import { memo, useContext, useMemo, type ReactNode } from 'react';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import type { AgentTimelineProps } from './AgentTimeline.js';
import { TimelineEntry } from './TimelineEntry.js';
import { TimelineItemRenderer } from './TimelineItemRenderer.js';
import { ResourceList } from './ResourceList.js';
import { PreviewActions, type PreviewController } from './PreviewActions.js';
import { ProcessModeContext, TimelineSearchReveal } from './TimelineDisplay.js';
import type { MessageGroupPosition } from './timeline-render-model.js';
import { messageResources } from './message-resources.js';
import { RuntimeNoticeItem } from './items/ErrorItem.js';
import type { RuntimeNoticePresentation } from './RuntimeNoticeGroup.js';
import { type AgentReplicaState } from '@orchardworks/agent-client';

interface ConversationEntryProps extends Pick<AgentTimelineProps, 'onEditPrompt' | 'onInspectEntry' | 'resolveSessionLink'
  | 'onResourceResolve' | 'onResourceRequest'>, RuntimeNoticePresentation {
  entry: ProjectedTimelineEntry;
  entryKey: string;
  messageGroup?: MessageGroupPosition;
  /** The foot of an answer bubble: the assistant's avatar on the last one (still in earlier turns), its room on the others. */
  foot?: 'avatar' | 'still' | 'space';
  agentId?: string;
  scopeKey: string;
  resources: AgentReplicaState['resources'];
  inspected: boolean;
  searchSelected?: boolean;
  previews?: PreviewController;
  extension?: ReactNode;
  /** available: a selection can start here; selected or unselected while one is in progress. */
  selection?: 'available' | 'selected' | 'unselected';
  selectionLabel?: string;
  onSelect?(entryKey: string, extend: boolean): void;
}

/**
 * A row renders again when its content, its other props or its identity change, not when only its sequence changes: a replacement
 * that renumbers the rows must leave an unchanged row alone. The row's sequence is read again from the state when it is used.
 */
function sameRow(previous: ConversationEntryProps, next: ConversationEntryProps): boolean {
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof ConversationEntryProps>) {
    if (key !== 'entry' && !Object.is(previous[key], next[key])) return false;
  }
  const a = previous.entry, b = next.entry;
  return a === b || (a.item === b.item && a.resources === b.resources && a.collapsed === b.collapsed
    && a.timestamp === b.timestamp && a.turnId === b.turnId && a.providerId === b.providerId);
}

// Unchanged history stays mounted without rebuilding its controls on every delta.
export const ConversationEntry = memo(function ConversationEntry({ entry, entryKey, messageGroup, foot, agentId,
  scopeKey, resources, onEditPrompt, onInspectEntry, inspected, searchSelected, resolveSessionLink, onResourceResolve, onResourceRequest,
  previews, extension, noticeExpanded, noticeCount, onToggleNotice, noticeDetailsId, noticeControls, selection, selectionLabel, onSelect }: ConversationEntryProps) {
  const collapsed = noticeExpanded === false;
  // A message lists its attachments by their labels, without the images its prose already shows; Full, today's preview level,
  // and a step list every resource they named.
  const everyResource = useContext(ProcessModeContext) === 'full' || !isConversational(entry.item);
  const attachments = useMemo(() => messageResources(entry.item, entry.resources), [entry.item, entry.resources]);
  return <TimelineSearchReveal.Provider value={!!searchSelected}><TimelineEntry entryKey={entryKey}
    onEdit={onEditPrompt && !entry.item.background && entry.item.type === 'user_message' && !entry.item.withdrawn && entry.item.messageId && entry.turnId ? () => onEditPrompt(entry) : undefined}
    timestamp={entry.timestamp} sent={entry.item.type === 'user_message'}
    inspected={inspected || !!searchSelected} searchSelected={!!searchSelected} inspect={onInspectEntry ? () => onInspectEntry(entryKey) : undefined}
    selection={selection} selectionLabel={selectionLabel} onSelect={onSelect ? extend => onSelect(entryKey, extend) : undefined}>
    {entry.item.type === 'error' && noticeExpanded !== undefined && noticeDetailsId !== undefined
      ? <RuntimeNoticeItem item={entry.item} expanded={noticeExpanded} count={noticeCount} toggle={onToggleNotice}
          detailsId={noticeDetailsId} controls={noticeControls} />
      : <TimelineItemRenderer item={entry.item} entry={entry} messageGroup={messageGroup} resolveSessionLink={resolveSessionLink}
      resources={resources} resourceBindings={entry.resources} resourceScopeKey={scopeKey}
      onResourceResolve={onResourceResolve} onResourceRequest={onResourceRequest} foot={foot} />}
    {previews && agentId && entry.item.type !== 'error' && previewable(entry.item) ? <PreviewActions agentId={agentId} itemId={entryKey} text={previewText(entry.item)} controller={previews} /> : null}
    {!collapsed ? extension : null}
    {!collapsed ? <ResourceList bindings={everyResource ? entry.resources : attachments.bindings} labels={attachments.labels}
      resources={resources} onRequest={onResourceRequest} /> : null}
  </TimelineEntry></TimelineSearchReveal.Provider>;
}, sameRow);

function isConversational(item: AgentReplicaState['timeline']['entries'][number]['item']): boolean {
  return item.type === 'user_message' || item.type === 'assistant_message' || item.type === 'agent_communication';
}

const planTools = new Set(['update_plan', 'TodoWrite', 'todo_write', 'EnterPlanMode', 'ExitPlanMode', 'enter_plan_mode', 'exit_plan_mode', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
/** Items whose text may name a page to preview: messages, letters, plans, todos and decisions. */
function previewable(item: AgentReplicaState['timeline']['entries'][number]['item']): boolean {
  if (isConversational(item) || item.type === 'todo' || item.type === 'interaction' || item.type === 'error') return true;
  return item.type === 'tool_call' && planTools.has(item.name.split('.').at(-1) ?? item.name);
}

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
