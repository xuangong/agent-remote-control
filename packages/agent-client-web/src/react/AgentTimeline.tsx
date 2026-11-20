import { ResourceDownloadContext, type DownloadResource } from './ResourceDownload.js';
import type { ResourceResponseState } from '@orchardworks/agent-remote-protocol';
import { useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AgentInteractionResponse,
  ResourceBinding,
} from '@orchardworks/agent-remote-protocol';

import type { SessionLinkResolver } from './items/ToolCallItem.js';
import { AgentChildSessionList, type AgentChildSessionView } from './AgentChildSessionList.js';
import { InteractionPanel } from './InteractionPanel.js';
import type { QuestionDraft } from './interactions/QuestionCard.js';
import type { RendererRegistry } from './renderer-registry.js';
import { ConversationEntry } from './ConversationEntry.js';
import type { TimelineRenderEntry } from './timeline-render-model.js';
import { useRuntimeNoticeDisclosure } from './RuntimeNoticeGroup.js';
import type { PreviewController } from './PreviewActions.js';
import { usePreviewController } from './PreviewContext.js';
import { OutgoingMessageItem } from './OutgoingMessageItem.js';
import { ProcessModeContext, TimelineLettersVisible } from './TimelineDisplay.js';
import { useTimelineAction } from './useTimelineAction.js';
import { TimelineTurn, type TurnRowOptions } from './TimelineTurn.js';
import { BubbleAvatarContext } from './bubble-foot.js';
import { LocaleContext, useTranslate } from './locale.js';
import { TurnStatus } from './TurnStatus.js';
import { dayLineLabel, errorWords, foldTurns, startsDayLine, timelineEntryKey, workDisclosure, type AgentReplicaState, type ProcessMode, type Turn } from '@orchardworks/agent-client';

export type AgentTimelineState = AgentReplicaState;

/** Lets the user pick conversation messages, for example to quote them elsewhere. */
export interface TimelineEntrySelection {
  /** Keys of the selected entries; undefined until the user starts selecting. */
  readonly selected?: ReadonlySet<string>;
  /** Names what selecting is for, such as "Quote"; it labels the action that starts a selection. */
  readonly label: string;
  /** Selects or deselects entries, given by their entry keys. */
  select(keys: readonly string[], selected: boolean): void;
}
/** Conversation messages and tool calls can be selected; other entries are not part of the conversation. */
export function isSelectableTimelineItem(item: AgentReplicaState['timeline']['entries'][number]['item']): boolean {
  return item.type === 'user_message' ? !item.withdrawn : item.type === 'assistant_message' || item.type === 'tool_call';
}

export interface AgentTimelineProps {
  readonly onDownloadResource?: DownloadResource;
  readonly searchEntryKey?: string;
  readonly searchRequestId?: number;
  readonly onEditPrompt?: (entry: import('@orchardworks/agent-remote-protocol').ProjectedTimelineEntry) => Promise<void>;
  readonly state: AgentReplicaState;
  readonly onRetryMessage?: (id: string) => Promise<void>;
  readonly onDeleteMessage?: (id: string) => void;
  readonly onInspectEntry?: (entryKey: string) => void;
  readonly inspectedEntryKey?: string;
  readonly inspectedRequestId?: number;
  readonly childrenFor?: (nativeSessionId: string) => readonly AgentChildSessionView[];
  readonly resolveSessionLink?: SessionLinkResolver;
  readonly registry?: RendererRegistry;
  /** How much of each turn's work shows (section 4.2 of the I3 plan); the host's ProcessModeContext, Concise, when it says nothing. */
  readonly processMode?: ProcessMode;
  /** Who answers: the name the live line uses and the avatar at the foot of the answers. A host without one shows "Assistant" and no avatar. */
  readonly assistant?: { readonly name: string; readonly avatar?: ReactNode };
  readonly onOpenChildSession?: (child: AgentChildSessionView) => void | Promise<void>;
  readonly historyLoading?: boolean;
  readonly historyError?: string;
  readonly onLoadOlder?: () => void | Promise<void>;
  readonly onInteractionResponse?: (requestId: string, response: AgentInteractionResponse) => Promise<void>;
  readonly interactionDisabled?: boolean;
  readonly interactionsWaitingForConnection?: boolean;
  readonly interactionsReadOnly?: boolean;
  readonly onResourceRequest?: (binding: ResourceBinding) => Promise<void | ResourceResponseState>;
  readonly onResourceResolve?: (locator: string, sourceLocator?: string) => Promise<ResourceBinding>;
  readonly questionDrafts?: Readonly<Record<string, QuestionDraft>>;
  readonly onQuestionDraftChange?: (requestId: string, draft: QuestionDraft) => void;
  readonly previewController?: PreviewController;
  readonly entrySelection?: TimelineEntrySelection;
  /**
   * Content shown above this conversation's own entries once its oldest page is loaded, such as the earlier sessions of a bot
   * after a handoff. While older pages of its own remain, History controls come first.
   */
  readonly timelineStart?: ReactNode;
  /** Presence below the latest entry, such as a bot's typing indicator; it is not an entry and moves nothing. */
  readonly timelineEnd?: ReactNode;
}

export function AgentTimeline({
  state,
  searchEntryKey,
  searchRequestId,
  onEditPrompt,
  onRetryMessage,
  onDeleteMessage,
  registry,
  resolveSessionLink,
  childrenFor,
  processMode: processModeProp,
  assistant,
  onLoadOlder,
  historyLoading,
  historyError,
  onOpenChildSession,
  onInteractionResponse,
  interactionDisabled = false,
  interactionsWaitingForConnection = false,
  interactionsReadOnly = false,
  onDownloadResource,
  onResourceRequest,
  onResourceResolve,
  questionDrafts,
  onQuestionDraftChange,
  previewController,
  onInspectEntry,
  inspectedEntryKey,
  inspectedRequestId,
  entrySelection,
  timelineStart,
  timelineEnd,
}: AgentTimelineProps) {
  const inheritedPreviewController = usePreviewController();
  const previews = previewController ?? inheritedPreviewController;
  const lettersVisible = useContext(TimelineLettersVisible);
  const inheritedProcessMode = useContext(ProcessModeContext);
  const processMode = processModeProp ?? inheritedProcessMode;
  const locale = useContext(LocaleContext);
  const t = useTranslate();
  const scopeKey = JSON.stringify([state.agent?.id]);
  const editPrompt = useTimelineAction(scopeKey, onEditPrompt);
  const inspectEntry = useTimelineAction(scopeKey, onInspectEntry);
  const resolveResource = useTimelineAction(scopeKey, onResourceResolve);
  const requestResource = useTimelineAction(scopeKey, onResourceRequest);
  const editablePrompts = useMemo(() => {
    const prompts = new Set<import('@orchardworks/agent-remote-protocol').ProjectedTimelineEntry>();
    const turns = new Set<string>();
    // Inspect the unfiltered timeline: hidden activity still proves a prompt is mid-turn.
    for (const entry of state.timeline.entries) {
      if (!entry.turnId) continue;
      const turn = JSON.stringify([entry.providerId, entry.turnId]);
      if (turns.has(turn)) continue;
      const incompleteBoundary = state.timeline.hasOlder && turns.size === 0;
      turns.add(turn);
      // The first loaded turn may start on an older page. Keep its edit action hidden until known.
      if (!incompleteBoundary && entry.item.type === 'user_message' && !entry.item.background && entry.item.messageId) prompts.add(entry);
    }
    return prompts;
  }, [state.timeline.entries, state.timeline.hasOlder]);
  // The fold reads every entry, so a turn keeps its key while letters are hidden; hidden letters only leave the screen.
  const folded = useMemo(() => foldTurns(state.timeline.entries, state.agent?.activeTurn ?? null, state.agent?.status, state.pendingInteractions.length),
    [state.timeline.entries, state.agent?.activeTurn, state.agent?.status, state.pendingInteractions.length]);
  // Hidden letters leave the screen, except the one a search or a Trace target shows: the reader's choice holds in every view.
  const shownTurns = useMemo(() => lettersVisible ? folded : folded.map(turn => turn.letters.length ? { ...turn, letters: turn.letters.filter(entry => {
    const key = timelineEntryKey(entry);
    return key === searchEntryKey || key === inspectedEntryKey;
  }) } : turn), [folded, lettersVisible, searchEntryKey, inspectedEntryKey]);
  const turns = useStableTurns(shownTurns);
  const placement = useMemo(() => turnPlacement(turns), [turns]);
  // The reader's own toggle of a turn's work line holds until the mode changes.
  const readerScope = JSON.stringify([state.agent?.id, processMode]);
  const revealRequest = JSON.stringify([searchEntryKey, searchRequestId, inspectedEntryKey, inspectedRequestId]);
  const [reader, setReader] = useState(() => ({ scope: readerScope, request: '', choices: new Map<string, boolean>(), revealed: new Set<string>() }));
  let current = reader;
  if (reader.scope !== readerScope || reader.request !== revealRequest) {
    // A search or Trace target opens its turn while it is the target: a new one takes the reader's choice for that turn back, and
    // once the search closes or the target moves on, the turn shows as its mode and the reader's own toggles say.
    const choices = new Map(reader.scope === readerScope ? reader.choices : []), revealed = new Set<string>();
    for (const key of [searchEntryKey, inspectedEntryKey]) {
      const turn = key === undefined ? undefined : placement.workTurn.get(key);
      if (turn !== undefined) { choices.delete(turn); revealed.add(turn); }
    }
    current = { scope: readerScope, request: revealRequest, choices, revealed };
    // Reveal during rendering: the workbench locates search and Trace targets in a layout effect.
    setReader(current);
  }
  const toggleTurn = useCallback((key: string, open: boolean) => setReader(previous => {
    const choices = new Map(previous.scope === readerScope ? previous.choices : []), revealed = new Set(previous.scope === readerScope ? previous.revealed : []);
    choices.set(key, !open); revealed.delete(key);
    return { ...previous, scope: readerScope, choices, revealed };
  }), [readerScope]);
  const disclosures = turns.map(turn => workDisclosure(processMode, turn.state, current.choices.get(turn.key), current.revealed.has(turn.key)));
  const selectionAnchor = useRef<string>();
  const selectedKeys = entrySelection?.selected;
  if (!selectedKeys) selectionAnchor.current = undefined;
  const selectEntry = useTimelineAction(scopeKey, entrySelection ? (key: string, extend: boolean) => {
    // A range is taken over the entries shown, in the order they show: a closed work line's steps are never selected unseen.
    const shown = turns.flatMap((turn, index) => [...(turn.prompt ? [turn.prompt] : []),
      ...turn.work.filter(step => step.kind !== 'interaction_receipt' ? disclosures[index]!.line === 'open' : false).flatMap(step => step.entries),
      ...turn.work.filter(step => step.kind === 'interaction_receipt').flatMap(step => step.entries), ...turn.answer, ...turn.letters]);
    const order = shown.filter(entry => isSelectableTimelineItem(entry.item)).map(timelineEntryKey);
    const anchor = selectionAnchor.current, from = anchor === undefined ? -1 : order.indexOf(anchor), to = order.indexOf(key);
    selectionAnchor.current = key;
    if (extend && from >= 0 && to >= 0) entrySelection.select(order.slice(Math.min(from, to), Math.max(from, to) + 1), true);
    else entrySelection.select([key], !selectedKeys?.has(key));
  } : undefined);
  const notices = useRuntimeNoticeDisclosure(scopeKey, searchEntryKey, inspectedEntryKey, searchRequestId, inspectedRequestId);
  // A host may hand a new resolver on every render; rows resolve through the latest one, so a new function alone renders nothing again.
  const latestSessionLinks = useRef(resolveSessionLink);
  latestSessionLinks.current = resolveSessionLink;
  const hasSessionLinks = !!resolveSessionLink;
  const sessionLinks = useMemo<SessionLinkResolver | undefined>(() => hasSessionLinks ? nativeSessionId => latestSessionLinks.current!(nativeSessionId) : undefined, [hasSessionLinks]);
  const agentId = state.agent?.id, resources = state.resources, selectionLabel = entrySelection?.label;
  // One function while what every row reads stays the same, so a turn that did not change is not rendered again.
  const renderEntry = useCallback(({ entry, key, messageGroup }: TimelineRenderEntry, options?: TurnRowOptions) => {
    const { editable, ...presentation } = options ?? {};
    return <ConversationEntry key={key} entry={entry} entryKey={key}
      searchSelected={key === searchEntryKey} messageGroup={messageGroup} agentId={agentId}
      scopeKey={scopeKey} resources={resources}
      onEditPrompt={editable ? editPrompt : undefined}
      selection={selectEntry && isSelectableTimelineItem(entry.item) ? selectedKeys ? selectedKeys.has(key) ? 'selected' : 'unselected' : 'available' : undefined}
      selectionLabel={selectionLabel} onSelect={selectEntry}
      onInspectEntry={inspectEntry} inspected={inspectedEntryKey === key}
      resolveSessionLink={entry.item.type === 'tool_call' ? sessionLinks : undefined}
      onResourceResolve={resolveResource} onResourceRequest={requestResource}
      previews={previews} extension={registry?.render(entry.item)}
      {...presentation} />;
    // The registry is mutable: its revision says when its renderers changed.
  }, [searchEntryKey, agentId, scopeKey, resources, editPrompt, selectEntry, selectedKeys, selectionLabel, inspectEntry, inspectedEntryKey, sessionLinks,
    resolveResource, requestResource, previews, registry, registry?.revision]);
  // Day lines read every turn's times, so they are worked out again only when the turns, the language or the day change.
  const today = new Date().toDateString();
  const separators = useMemo(() => {
    const now = Date.now();
    return turns.map((turn, index) => {
      const previous = turns[index - 1];
      const start = (turn.prompt ?? turn.work[0]?.entries[0] ?? turn.answer[0] ?? turn.letters[0])?.timestamp;
      return start && startsDayLine(previous ? lastTimestamp(previous) : undefined, start) ? { label: dayLineLabel(start, now, locale, t), timestamp: start } : undefined;
    });
  }, [turns, locale, t, today]);
  const assistantName = assistant?.name || t('conversation.assistant');
  // The live line shows while the assistant works on a turn and nothing waits for the person.
  const agent = state.agent;
  const working = !!agent && (agent.status === 'running' || agent.status === 'starting') && !state.pendingInteractions.length
    && agent.runtimeInfo.connection?.state !== 'unavailable';
  const lastTurn = turns.at(-1);
  const live = working ? <TurnStatus name={assistantName} turn={lastTurn?.state === 'running' ? lastTurn : undefined}
    startedAt={agent?.activeTurn?.startedAt} avatar={assistant?.avatar} /> : null;
  const liveInTurn = !!live && lastTurn?.state === 'running';
  // Requests waiting for the person belong to the turn that asked: the last one, after its answer.
  const pending = state.pendingInteractions.length ? <div className="agent-turn-requests">
    {state.pendingInteractions.map((request) => <fieldset
      className="agent-interaction-lock"
      disabled={interactionDisabled}
      key={JSON.stringify([state.agent?.id, request.requestId])}
    ><InteractionPanel
        readOnly={interactionsReadOnly}
        waitingForConnection={interactionsWaitingForConnection}
        request={request}
        onResponse={onInteractionResponse}
        assistantName={assistantName}
        questionDraft={questionDrafts?.[request.requestId]}
        onQuestionDraftChange={onQuestionDraftChange ? (draft) => onQuestionDraftChange(request.requestId, draft) : undefined}
      /></fieldset>)}
  </div> : null;
  const outgoing = (state.outgoingMessages ?? []).filter(message => message.agentId === state.agent?.id);
  const discovered = useRef({ identity: '', order: new Map<string, number>() });
  const identity = JSON.stringify([state.agent?.providerId, state.agent?.id]);
  if (discovered.current.identity !== identity) discovered.current = { identity, order: new Map() };
  const nativeSessionId = state.agent?.runtimeInfo.sessionId;
  const recorded = nativeSessionId ? childrenFor?.(nativeSessionId) ?? [] : [];
  const children = [...new Map([...recorded, ...(state.agent?.runtimeInfo.childSessions ?? [])].map(child => [child.nativeSessionId, child])).values()];
  for (const child of children) {
    if (!discovered.current.order.has(child.nativeSessionId)) discovered.current.order.set(child.nativeSessionId, discovered.current.order.size);
  }
  children.sort((a, b) => (Date.parse(a.createdAt ?? '') - Date.parse(b.createdAt ?? ''))
    || discovered.current.order.get(a.nativeSessionId)! - discovered.current.order.get(b.nativeSessionId)!);
  return <ResourceDownloadContext.Provider value={onDownloadResource}><section className="agent-remote-surface" aria-label={t('timeline.label')}>

    {state.timeline.hasOlder ? <HistoryControls loading={historyLoading} error={historyError}
      key={JSON.stringify([state.agent?.id])}
      onLoadOlder={onLoadOlder}
    /> : timelineStart ?? null}

    <ProcessModeContext.Provider value={processMode}><BubbleAvatarContext.Provider value={assistant?.avatar}><div className="agent-timeline-entries" aria-live="polite" data-process-mode={processMode}
      data-revealing={searchEntryKey !== undefined || inspectedEntryKey !== undefined || undefined}>
      {turns.length === 0 && outgoing.length === 0
        ? timelineStart && !state.timeline.hasOlder ? null : <p className="agent-timeline-empty">{t('timeline.empty')}</p>
        : turns.map((turn, index) => {
            const disclosure = disclosures[index]!;
            return <TimelineTurn key={turn.key} turn={turn} disclosure={disclosure} separator={separators[index]}
              onToggle={toggleTurn} renderEntry={renderEntry} groups={notices}
              promptEditable={!!turn.prompt && editablePrompts.has(turn.prompt)} latest={index === turns.length - 1}
              after={index === turns.length - 1 ? <>{pending}{liveInTurn ? live : null}</> : undefined} />;
          })}
      {outgoing.map(message => <OutgoingMessageItem key={message.id} message={message} resourceContext={onResourceResolve && onResourceRequest ? { scopeKey: JSON.stringify([state.agent?.id]), bindings: [], resources: state.resources, resolveResource: onResourceResolve, requestResource: onResourceRequest } : undefined} onRetry={onRetryMessage} onDelete={onDeleteMessage} />)}
      {turns.length === 0 ? pending : null}
      {live && !liveInTurn ? live : null}
      {timelineEnd ?? null}
    </div></BubbleAvatarContext.Provider></ProcessModeContext.Provider>

    <AgentChildSessionList childrenFor={childrenFor} key={identity} children={children} label={t('timeline.subagents')} collapsible onOpenChildSession={onOpenChildSession} />

  </section></ResourceDownloadContext.Provider>;
}

/**
 * The previous fold's turn object for each turn whose rows and state did not change, so a new row, a status change or a
 * message being sent renders the one turn it touched.
 */
function useStableTurns(turns: readonly Turn[]): readonly Turn[] {
  const previous = useRef(new Map<string, Turn>());
  return useMemo(() => {
    const before = previous.current;
    const stable = turns.map(turn => { const earlier = before.get(turn.key); return earlier && sameTurnRows(earlier, turn) ? earlier : turn; });
    previous.current = new Map(stable.map(turn => [turn.key, turn]));
    return stable;
  }, [turns]);
}

type Row = Turn['answer'][number];
/** The same row as a row renders it (ConversationEntry's rule), under the same key. */
const sameRow = (a: Row | undefined, b: Row | undefined) => a === b || !!a && !!b && a.item === b.item && a.resources === b.resources
  && a.collapsed === b.collapsed && a.timestamp === b.timestamp && a.turnId === b.turnId && a.providerId === b.providerId && timelineEntryKey(a) === timelineEntryKey(b);
const sameEntries = (a: readonly Row[], b: readonly Row[]) => a.length === b.length && a.every((entry, index) => sameRow(entry, b[index]));
function sameTurnRows(a: Turn, b: Turn): boolean {
  return a.state === b.state && a.turnId === b.turnId && sameRow(a.prompt, b.prompt) && sameEntries(a.answer, b.answer) && sameEntries(a.letters, b.letters)
    && a.work.length === b.work.length && a.work.every((step, index) => {
      const other = b.work[index]!;
      return step.key === other.key && step.kind === other.kind && step.state === other.state && sameEntries(step.entries, other.entries);
    });
}

/** The turn whose work line holds each step entry: a search or Trace target there opens its turn. */
function turnPlacement(turns: readonly Turn[]) {
  const workTurn = new Map<string, string>();
  for (const turn of turns) for (const step of turn.work) if (step.kind !== 'interaction_receipt') for (const entry of step.entries) workTurn.set(timelineEntryKey(entry), turn.key);
  return { workTurn };
}

/** When a turn's last row happened. */
function lastTimestamp(turn: Turn): string | undefined {
  let last: import('@orchardworks/agent-remote-protocol').ProjectedTimelineEntry | undefined;
  for (const entry of [...(turn.prompt ? [turn.prompt] : []), ...turn.work.flatMap(step => step.entries), ...turn.answer, ...turn.letters]) {
    if (!last || entry.seqStart > last.seqStart) last = entry;
  }
  return last?.timestamp;
}

function HistoryControls({ onLoadOlder, loading = false, error }: { readonly onLoadOlder?: () => void | Promise<void>; loading?: boolean; error?: string }) {
  const t = useTranslate();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();

  async function loadOlder(): Promise<void> {
    if (!onLoadOlder || inFlight.current || loading) return;
    inFlight.current = true;
    setPending(true);
    setFailure(undefined);
    try {
      await onLoadOlder();
    } catch (error) {
      setFailure(errorWords(error, t, 'timeline.history.failed'));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return <div className="agent-history-controls">
    <button
      className="agent-load-older"
      type="button"
      disabled={!onLoadOlder || pending || loading}
      aria-busy={pending || loading}
      onClick={() => { void loadOlder(); }}
    >{t(pending || loading ? 'timeline.history.loading' : 'timeline.history.load')}</button>
    {failure || error ? <p className="agent-history-error" role="alert">{failure ?? error}</p> : null}
  </div>;
}
