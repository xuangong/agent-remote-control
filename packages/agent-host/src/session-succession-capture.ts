import { MAX_NORMALIZED_CONTEXT_ENTRIES, type ProjectedTimelineEntry, type TimelineCursor } from '@orchardworks/agent-remote-protocol';
import type { SessionWireAgent } from '@orchardworks/agent-remote-relay';

/** Capture one complete normalized history without executing or advancing the session. */
export async function captureSuccessionTimeline(agent: SessionWireAgent) {
  const boundary = agent.timelineCursor?.();
  if (!boundary) throw new Error('An authoritative timeline boundary is required for succession.');
  const entries: ProjectedTimelineEntry[] = [];
  let cursor: TimelineCursor | undefined;
  for (let pageIndex = 0; pageIndex < MAX_NORMALIZED_CONTEXT_ENTRIES; pageIndex++) {
    const request = { requestId: 'succession-capture', agentId: agent.agentId,
      direction: cursor ? 'before' as const : 'tail' as const, ...(cursor ? { cursor } : {}), limit: Math.min(1000, MAX_NORMALIZED_CONTEXT_ENTRIES - entries.length) };
    if (request.limit < 1) throw new Error('Succession history exceeds the normalized context entry budget.');
    const { payload: page } = await (agent.loadTimeline?.(request) ?? agent.fetchTimeline(request));
    const current = agent.timelineCursor?.();
    if (page.reset || page.staleCursor || page.gap || page.error || page.epoch !== boundary.epoch
      || current?.epoch !== boundary.epoch || current.seq !== boundary.seq) throw new Error('Succession history changed or is incomplete.');
    if (cursor && page.entries.some(entry => entry.seqStart >= cursor!.seq)) throw new Error('Succession history did not advance toward older entries.');
    entries.unshift(...page.entries);
    if (!page.hasOlder) return { entries, boundary, capturedAt: new Date().toISOString() };
    if (!page.startCursor || (cursor && page.startCursor.seq >= cursor.seq)) throw new Error('Succession history is missing its continuation.');
    cursor = page.startCursor;
  }
  throw new Error('Succession history capture exceeded its page budget.');
}
