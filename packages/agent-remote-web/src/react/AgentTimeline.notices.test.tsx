import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { createReplicaState } from '../replica/reducer.js';
import { timelineEntryKey } from '../replica/timeline-entry-key.js';
import { render, rerender } from '../test/setup.js';
import { AgentTimeline, type AgentTimelineProps } from './AgentTimeline.js';
import { TimelineDisplay, type TimelineDisplayMode } from './TimelineDisplay.js';

const epoch = 'notice-history';
const messages = [
  'First runtime detail: startup timed out.\nSet startup_timeout_sec to 30 and retry.',
  'Second runtime detail: optional server unavailable.\nThe complete diagnostic remains useful.',
  'Third runtime detail: connection restored.\nKeep the full follow-up explanation.',
  'Fourth runtime detail: another notice arrived.\nKeep this group open while reading.',
];

function entry(seq: number, item: ProjectedTimelineEntry['item']): ProjectedTimelineEntry {
  return {
    providerId: 'test', item, seqStart: seq, seqEnd: seq,
    timestamp: `2026-10-03T00:00:0${seq}.000Z`,
    sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], resources: [],
  };
}

function notices(count = 3): ProjectedTimelineEntry[] {
  return messages.slice(0, count).map((message, index) => entry(index + 1, { type: 'error', message }));
}

function view(entries: ProjectedTimelineEntry[], mode: TimelineDisplayMode = 'preview', searchEntryKey?: string,
  inspection: Pick<AgentTimelineProps, 'onInspectEntry' | 'inspectedEntryKey' | 'searchRequestId' | 'inspectedRequestId'> = {}) {
  const base = createReplicaState();
  const state = { ...base, timeline: { ...base.timeline, epoch, initialized: true, entries,
    nextSeq: (entries.at(-1)?.seqEnd ?? 0) + 1 } };
  return <TimelineDisplay.Provider value={mode}>
    <AgentTimeline state={state} showHeader={false} searchEntryKey={searchEntryKey} {...inspection} />
  </TimelineDisplay.Provider>;
}

function noticeToggles(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
    .filter(button => /Runtime notices?/.test(button.textContent ?? ''));
}

function visibleText(node: Node): string {
  if (node instanceof HTMLElement && (node.hidden || node.getAttribute('aria-hidden') === 'true')) return '';
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  return [...node.childNodes].map(visibleText).join('');
}

function renderedEntry(container: HTMLElement, item: ProjectedTimelineEntry): HTMLElement | null {
  const key = timelineEntryKey(epoch, item);
  return container.querySelector<HTMLElement>(`.agent-timeline-entry[data-entry-key="${key}"]`);
}

describe('runtime notice groups', () => {
  it.each(['preview', 'simple', 'content'] as const)('starts three consecutive notices as one quiet closed group in %s mode', async mode => {
    const container = await render(view(notices(), mode));
    const toggles = noticeToggles(container);
    expect(toggles).toHaveLength(1);
    expect(toggles[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(toggles[0]!.querySelector('.agent-notice-count')?.textContent).toBe('3');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const visible = visibleText(container);
    for (const message of messages.slice(0, 3)) expect(visible).not.toContain(message.split('\n')[0]);
    expect([...container.querySelectorAll('.agent-content-preview, .agent-notice-summary')]
      .filter(node => visibleText(node).trim())).toHaveLength(0);
  });

  it('keeps a message between notice groups in its original timeline position', async () => {
    const first = notices(2);
    const message = entry(3, { type: 'assistant_message', text: 'A real answer separates these notices.' });
    const second = [entry(4, { type: 'error', message: messages[2]! }), entry(5, { type: 'error', message: messages[3]! })];
    const container = await render(view([...first, message, ...second]));
    const toggles = noticeToggles(container);
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) {
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.querySelector('.agent-notice-count')?.textContent).toBe('2');
    }
    const answer = renderedEntry(container, message)!;
    expect(visibleText(answer)).toContain('A real answer separates these notices.');
    expect(toggles[0]!.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(answer.compareDocumentPosition(toggles[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => toggles[0]!.click());
    expect(visibleText(container)).toContain(messages[0]);
    expect(visibleText(container)).not.toContain(messages[2]!.split('\n')[0]);
    expect(toggles[1]!.getAttribute('aria-expanded')).toBe('false');
  });

  it('does not join notices across a non-notice entry hidden by content-only mode', async () => {
    const container = await render(view([
      entry(1, { type: 'error', message: messages[0]! }),
      entry(2, { type: 'tool_call', callId: 'command', name: 'shell', status: 'completed', error: null,
        detail: { type: 'shell', command: 'echo internal' } }),
      entry(3, { type: 'error', message: messages[1]! }),
    ], 'content'));
    expect(container.querySelector('.agent-tool')).toBeNull();
    expect(noticeToggles(container)).toHaveLength(2);
  });

  it('opens every complete notice with one action and stays open as another notice arrives', async () => {
    const entries = notices();
    const container = await render(view(entries));
    const toggle = noticeToggles(container)[0]!;
    await act(async () => toggle.click());
    expect(noticeToggles(container)).toHaveLength(1);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    for (const [index, item] of entries.entries()) {
      const rendered = renderedEntry(container, item);
      expect(rendered).not.toBeNull();
      expect(visibleText(rendered!)).toContain(messages[index]);
    }
    await rerender(container, view([...entries, notices(4)[3]!]));
    const updated = noticeToggles(container);
    expect(updated).toHaveLength(1);
    expect(updated[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(updated[0]!.querySelector('.agent-notice-count')?.textContent).toBe('4');
    for (const message of messages) expect(visibleText(container)).toContain(message);
    await act(async () => updated[0]!.click());
    expect(updated[0]!.getAttribute('aria-expanded')).toBe('false');
    for (const message of messages) expect(visibleText(container)).not.toContain(message.split('\n')[0]);
  });

  it.each(['preview', 'content'] as const)('reveals a search hit at its real entry inside a closed group in %s mode', async mode => {
    const entries = notices();
    const selected = entries[1]!;
    const key = timelineEntryKey(epoch, selected);
    const container = await render(view(entries, mode));
    expect(noticeToggles(container)).toHaveLength(1);
    expect(noticeToggles(container)[0]!.getAttribute('aria-expanded')).toBe('false');
    await rerender(container, view(entries, mode, key));
    const toggles = noticeToggles(container);
    expect(toggles).toHaveLength(1);
    expect(toggles[0]!.getAttribute('aria-expanded')).toBe('true');
    const target = renderedEntry(container, selected);
    expect(target).not.toBeNull();
    expect(target!.closest('[hidden]')).toBeNull();
    expect(target!.getAttribute('data-inspected')).toBe('true');
    expect(container.querySelectorAll(`[data-entry-key="${key}"]`)).toHaveLength(1);
    expect(visibleText(target!)).toContain(messages[1]);
  });

  it('reopens the group when search moves to another notice after the previous hit was collapsed', async () => {
    const entries = notices();
    const firstKey = timelineEntryKey(epoch, entries[0]!);
    const secondKey = timelineEntryKey(epoch, entries[1]!);
    const container = await render(view(entries, 'content', firstKey));
    expect(noticeToggles(container)).toHaveLength(1);
    const toggle = noticeToggles(container)[0]!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await rerender(container, view(entries, 'content', secondKey));
    expect(noticeToggles(container)[0]!.getAttribute('aria-expanded')).toBe('true');
    const target = renderedEntry(container, entries[1]!)!;
    expect(target.closest('[hidden]')).toBeNull();
    expect(visibleText(target)).toContain(messages[1]);
    expect(target.getAttribute('data-inspected')).toBe('true');
    expect(renderedEntry(container, entries[0]!)!.getAttribute('data-inspected')).toBeNull();
  });

  it('preserves an open group when older history adds notices to its beginning', async () => {
    const existing = [entry(3, { type: 'error', message: messages[2]! }), entry(4, { type: 'error', message: messages[3]! })];
    const container = await render(view(existing));
    expect(noticeToggles(container)).toHaveLength(1);
    await act(async () => noticeToggles(container)[0]!.click());
    expect(noticeToggles(container)[0]!.getAttribute('aria-expanded')).toBe('true');
    await rerender(container, view([...notices(2), ...existing]));
    expect(noticeToggles(container)).toHaveLength(1);
    expect(noticeToggles(container)[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(noticeToggles(container)[0]!.querySelector('.agent-notice-count')?.textContent).toBe('4');
    for (const message of messages) expect(visibleText(container)).toContain(message);
    expect(renderedEntry(container, existing[0]!)).not.toBeNull();
  });

  it('retains each expanded notice as an original timeline anchor with its time and Trace action', async () => {
    const entries = notices();
    const inspect = vi.fn();
    const container = await render(view(entries, 'preview', undefined, { onInspectEntry: inspect }));
    await act(async () => noticeToggles(container)[0]!.click());
    const list = container.querySelector('.agent-timeline-entries')!;
    for (const item of entries) {
      const key = timelineEntryKey(epoch, item);
      const rendered = renderedEntry(container, item)!;
      expect(rendered.parentElement).toBe(list);
      expect(container.querySelectorAll(`[data-entry-key="${key}"]`)).toHaveLength(1);
      expect(rendered.querySelector('time')?.getAttribute('datetime')).toBe(item.timestamp);
      const trace = rendered.querySelector<HTMLButtonElement>(`button[aria-label="Inspect event #${item.seqStart} in Trace"]`);
      expect(trace).not.toBeNull();
      await act(async () => trace!.click());
    }
    expect(inspect.mock.calls.map(([key]) => key)).toEqual(entries.map(item => timelineEntryKey(epoch, item)));
  });

  it('reveals a Trace target and reopens its group when inspection moves to another notice', async () => {
    const entries = notices();
    const inspect = vi.fn();
    const container = await render(view(entries, 'preview', undefined, { onInspectEntry: inspect }));
    expect(noticeToggles(container)[0]!.getAttribute('aria-expanded')).toBe('false');
    await rerender(container, view(entries, 'preview', undefined, {
      onInspectEntry: inspect, inspectedEntryKey: timelineEntryKey(epoch, entries[1]!),
    }));
    expect(noticeToggles(container)[0]!.getAttribute('aria-expanded')).toBe('true');
    const firstTarget = renderedEntry(container, entries[1]!)!;
    expect(firstTarget.closest('[hidden]')).toBeNull();
    expect(firstTarget.getAttribute('data-inspected')).toBe('true');
    expect(visibleText(firstTarget)).toContain(messages[1]);
    await act(async () => noticeToggles(container)[0]!.click());
    expect(noticeToggles(container)[0]!.getAttribute('aria-expanded')).toBe('false');
    await rerender(container, view(entries, 'preview', undefined, {
      onInspectEntry: inspect, inspectedEntryKey: timelineEntryKey(epoch, entries[2]!),
    }));
    expect(noticeToggles(container)[0]!.getAttribute('aria-expanded')).toBe('true');
    const nextTarget = renderedEntry(container, entries[2]!)!;
    expect(nextTarget.closest('[hidden]')).toBeNull();
    expect(nextTarget.getAttribute('data-inspected')).toBe('true');
    expect(visibleText(nextTarget)).toContain(messages[2]);
    expect(renderedEntry(container, entries[1]!)!.getAttribute('data-inspected')).toBeNull();
  });

  it.each(['search', 'Trace'] as const)('reopens the same %s target on a new locate request after the group was collapsed', async source => {
    const entries = notices();
    const target = entries[1]!;
    const key = timelineEntryKey(epoch, target);
    const locate = (requestId: number) => source === 'search'
      ? view(entries, 'content', key, { searchRequestId: requestId })
      : view(entries, 'preview', undefined, { inspectedEntryKey: key, inspectedRequestId: requestId });
    const container = await render(locate(1));
    expect(noticeToggles(container)[0]!.getAttribute('aria-expanded')).toBe('true');
    await act(async () => noticeToggles(container)[0]!.click());
    expect(noticeToggles(container)[0]!.getAttribute('aria-expanded')).toBe('false');
    await rerender(container, locate(1));
    expect(noticeToggles(container)[0]!.getAttribute('aria-expanded')).toBe('false');
    await rerender(container, locate(2));
    expect(noticeToggles(container)[0]!.getAttribute('aria-expanded')).toBe('true');
    const rendered = renderedEntry(container, target)!;
    expect(rendered.closest('[hidden]')).toBeNull();
    expect(rendered.getAttribute('data-inspected')).toBe('true');
    expect(visibleText(rendered)).toContain(messages[1]);
  });
});
