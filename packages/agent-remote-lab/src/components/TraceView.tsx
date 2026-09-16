import type { AgentTimelineItem } from '@agent-remote-controller/agent-remote-protocol';
import type { AgentReplicaState } from '@agent-remote-controller/agent-remote-web';

export function TraceView({ state }: { state?: AgentReplicaState }) {
  const timeline = state?.timeline;
  return <div className="lab-trace-layout" aria-label="Normalized Timeline trace">
    <header className="lab-workbench-heading">
      <div>
        <p className="lab-eyebrow">Trace</p>
        <h2>Normalized Timeline trace</h2>
      </div>
      <span>{timeline?.epoch ? `${timeline.epoch} · seq ${Math.max(0, timeline.nextSeq - 1)}` : 'No replica attached'}</span>
    </header>
    <p className="lab-trace-notice">This view explains the normalized Timeline received by the Web client. Provider-native and raw wire frames are not retained by the public replica.</p>
    <ol className="lab-trace-list">
      {timeline?.entries.length ? timeline.entries.map((entry) => <li key={`${entry.providerId}:${entry.seqStart}:${entry.seqEnd}`}>
        <code className="lab-trace-sequence">{sequenceLabel(entry.seqStart, entry.seqEnd)}</code>
        <div className="lab-trace-event">
          <div><strong>{itemLabel(entry.item)}</strong><span>{entry.item.type}</span></div>
          <p>{entry.providerId} · source {sourceRanges(entry.sourceSeqRanges)}</p>
        </div>
        <div className="lab-trace-meta">
          <time dateTime={entry.timestamp}>{formatTime(entry.timestamp)}</time>
          <span>{entry.collapsed.length} merged · {entry.resources.length} resources</span>
        </div>
      </li>) : <li className="lab-trace-empty">No projected events are available yet.</li>}
    </ol>
  </div>;
}

function sequenceLabel(start: number, end: number): string {
  return start === end ? `#${start}` : `#${start}–${end}`;
}

function sourceRanges(ranges: readonly { startSeq: number; endSeq: number }[]): string {
  return ranges.map(({ startSeq, endSeq }) => startSeq === endSeq ? `${startSeq}` : `${startSeq}–${endSeq}`).join(', ');
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function itemLabel(item: AgentTimelineItem): string {
  switch (item.type) {
    case 'user_message': return 'User message';
    case 'assistant_message': return 'Assistant message';
    case 'reasoning': return 'Reasoning update';
    case 'tool_call': return item.name;
    case 'todo': return 'Task list';
    case 'interaction': return item.request.kind === 'question' ? 'Completed questions' : item.request.kind === 'plan_approval' ? 'Completed plan review' : 'Completed tool approval';
    case 'error': return 'Agent error';
    case 'compaction': return 'Context compacted';
  }
}
