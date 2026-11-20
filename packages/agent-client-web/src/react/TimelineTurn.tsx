import { type ReactNode } from 'react';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { timelineEntryKey, workSummary, type Turn, type WorkDisclosure, type WorkStep } from '@orchardworks/agent-client';
import { WorkSummaryLine } from '../primitives/WorkSummaryLine.js';
import { BackgroundActivityGroup } from './BackgroundActivityGroup.js';
import { RuntimeNoticeGroup, type RuntimeNoticePresentation } from './RuntimeNoticeGroup.js';
import { TimelineStepLevel } from './TimelineDisplay.js';
import type { TimelineRenderEntry } from './timeline-render-model.js';
import { useTranslate } from './locale.js';

export interface TurnRowOptions extends RuntimeNoticePresentation { readonly foot?: 'avatar' | 'space' }
export type RenderTurnEntry = (row: TimelineRenderEntry, options?: TurnRowOptions) => ReactNode;

export interface GroupDisclosure {
  isExpanded(entries: readonly TimelineRenderEntry[]): boolean;
  toggle(entries: readonly TimelineRenderEntry[]): void;
}

const row = (entry: ProjectedTimelineEntry): TimelineRenderEntry => ({ entry, key: timelineEntryKey(entry) });
/** Where a bubble sits in its answer's stack, so the stack reads as one reply. */
const stackPosition = (index: number, length: number) => length === 1 ? 'single' as const : index === 0 ? 'first' as const : index === length - 1 ? 'last' as const : 'middle' as const;

/**
 * One turn of the conversation (I3 plan, section 4.8): a day line when the day changes or half an hour passed, the person's
 * bubble, the work line with the turn's steps in place, answered interactions as their own lines, the answer bubbles with
 * the assistant's avatar at the foot of the last, and the letters. The rows are today's item renderers.
 */
export function TimelineTurn({ turn, disclosure, onToggle, renderEntry, groups, separator, after }: {
  turn: Turn;
  disclosure: WorkDisclosure;
  onToggle(): void;
  renderEntry: RenderTurnEntry;
  groups: GroupDisclosure;
  separator?: { readonly label: string; readonly timestamp: string };
  /** What follows the turn's own rows: requests waiting for the person and the live line, on the last turn. */
  after?: ReactNode;
}) {
  const t = useTranslate();
  const receipts = turn.work.filter(step => step.kind === 'interaction_receipt');
  const steps = turn.work.filter(step => step.kind !== 'interaction_receipt');
  const summary = workSummary(turn.work, t);
  return <div className="agent-turn" data-turn-key={turn.key} data-turn-state={turn.state}>
    {separator ? <div className="agent-day-separator" role="separator" aria-label={separator.label}>
      <time dateTime={separator.timestamp}>{separator.label}</time>
    </div> : null}
    {turn.prompt ? renderEntry(row(turn.prompt)) : null}
    {steps.length ? <WorkSummaryLine className="agent-work-line" summary={summary.text} open={disclosure.line === 'open'} onToggle={onToggle}
      note={summary.failed ? t('work.failed', { count: summary.failed }) : undefined}>
      <TimelineStepLevel.Provider value={disclosure.steps}>
        <div className="agent-work-steps" data-step-level={disclosure.steps}>
          {steps.map(step => <WorkStepRows key={step.key} step={step} renderEntry={renderEntry} groups={groups} />)}
        </div>
      </TimelineStepLevel.Provider>
    </WorkSummaryLine> : null}
    {receipts.map(step => renderEntry(row(step.entries[0]!)))}
    {turn.answer.map((entry, index) => renderEntry({ ...row(entry), messageGroup: stackPosition(index, turn.answer.length) },
      { foot: index === turn.answer.length - 1 ? 'avatar' : 'space' }))}
    {turn.letters.map(entry => renderEntry(row(entry)))}
    {after}
  </div>;
}

function WorkStepRows({ step, renderEntry, groups }: { step: WorkStep; renderEntry: RenderTurnEntry; groups: GroupDisclosure }) {
  const rows = step.entries.map(row);
  if (step.kind === 'background') {
    const checks = new Set(step.entries.flatMap(entry => entry.item.background ? [entry.item.background.id] : [])).size;
    return <BackgroundActivityGroup entries={rows} count={checks || 1} expanded={groups.isExpanded(rows)} toggle={() => groups.toggle(rows)} renderEntry={entry => renderEntry(entry)} />;
  }
  if (step.kind === 'notice') {
    return <RuntimeNoticeGroup entries={rows as Parameters<typeof RuntimeNoticeGroup>[0]['entries']} expanded={groups.isExpanded(rows)} toggle={() => groups.toggle(rows)} renderEntry={renderEntry} />;
  }
  return <>{rows.map(entry => renderEntry(entry))}</>;
}
