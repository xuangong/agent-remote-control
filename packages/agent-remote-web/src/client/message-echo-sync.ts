import type { TimelineCursor } from '@orchardworks/agent-remote-protocol';
import type { AgentReplica } from '../replica/store.js';
import type { AgentReplicaState } from '../replica/types.js';
import { anchorPosition } from '../replica/message-outbox.js';
import type { RemoteAgentTransport } from './transport.js';

/** Read-only repair for accepted input whose live Timeline echo has not arrived. */
export function watchMessageEchoes(agentId: string, transport: RemoteAgentTransport, replica: AgentReplica, pageSize: number): () => void {
  let stopped = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let scan: { start: number; cursor: TimelineCursor } | undefined;
  const waiting = () => {
    const state = replica.getState();
    return (state.outgoingMessages ?? []).filter(message => message.agentId === agentId
      && message.status === 'awaiting_echo' && anchorSeq(state, message.afterKey) !== undefined);
  };
  const update = () => {
    if (stopped) return;
    if (!waiting().length) {
      clearTimeout(timer); timer = undefined;
      request?.abort();
      attempts = 0; scan = undefined;
    } else if (!timer && !request) {
      const delay = attempts === 0 ? 10_000 : attempts === 1 ? 30_000 : 60_000;
      timer = setTimeout(() => { timer = undefined; void synchronize(); }, delay);
    }
  };
  async function synchronize(): Promise<void> {
    const messages = waiting();
    const epoch = replica.getState().timeline.epoch;
    if (stopped || !messages.length || !epoch) return;
    const state = replica.getState();
    const start = Math.min(...messages.map(message => anchorSeq(state, message.afterKey) ?? 0));
    let cursor = scan?.start === start && scan.cursor.epoch === epoch ? scan.cursor : { epoch, seq: start };
    const controller = new AbortController();
    request = controller;
    attempts++;
    const deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      // Bound each scan; continue from its last page on the next low-frequency check.
      for (let pages = 0; pages < 8; pages++) {
        const page = await transport.fetchTimeline(agentId, 'after', cursor, pageSize, { signal: controller.signal });
        if (stopped || controller.signal.aborted || replica.getState().timeline.epoch !== epoch) return;
        const payload = page.payload;
        if (payload.agentId !== agentId || payload.direction !== 'after' || payload.epoch !== epoch
          || payload.error || payload.reset || payload.staleCursor || payload.gap) return;
        replica.applyHistory(page, { preserveLive: true });
        if (controller.signal.aborted || !waiting().length) return;
        if (!payload.hasNewer) { scan = undefined; return; }
        const next = payload.endCursor;
        if (!next || next.epoch !== epoch || next.seq <= cursor.seq) return;
        cursor = next;
        scan = { start, cursor };
      }
    } catch {
      // A history read failure says nothing about delivery. Keep waiting and back off.
    } finally {
      clearTimeout(deadline);
      request = undefined;
      update();
    }
  }
  const unsubscribe = replica.subscribe(update);
  update();
  return () => {
    stopped = true;
    unsubscribe();
    clearTimeout(timer);
    request?.abort();
  };
}

/** The sequence a message was sent after: that of the row it names (0 for the start), undefined when the replica no longer holds the row. */
function anchorSeq(state: AgentReplicaState, afterKey: string | undefined): number | undefined {
  if (afterKey === undefined) return undefined;
  const position = anchorPosition(state, afterKey);
  return position === undefined ? undefined : position < 0 ? 0 : state.timeline.entries[position]?.seqEnd;
}
