import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryPage, TimelineCursor } from '@agent-remote-controller/agent-remote-protocol';
import type { AgentReplica } from '@agent-remote-controller/agent-remote-web';

export interface SessionCatchUp {
  id: number;
  state: 'catching_up' | 'complete' | 'unavailable';
  progress: number;
}

/** One fixed activity boundary per navigation, independent of later activity and Ready. */
export function useSessionCatchUp() {
  const [value, setValue] = useState<SessionCatchUp>();
  const release = useRef<() => void>();
  const targetReplica = useRef<AgentReplica>();
  const generation = useRef(0);
  const begin = useCallback((replica?: AgentReplica, cursor?: TimelineCursor) => {
    release.current?.(); release.current = undefined;
    const id = ++generation.current;
    targetReplica.current = cursor ? replica : undefined;
    if (!replica || !cursor) { setValue(undefined); return; }
    const target = { ...cursor };
    const initial = replica.getState().timeline;
    const start = initial.initialized && initial.epoch === target.epoch ? initial.nextSeq - 1 : 0;
    let complete = false;
    let unavailable = false;
    let progress = 0;
    const update = (historyEpoch?: string, direction?: HistoryPage['payload']['direction']) => {
      if (generation.current !== id || complete) return;
      const replicaState = replica.getState(), timeline = replicaState.timeline;
      if (historyEpoch !== undefined && direction !== 'before') unavailable = historyEpoch !== target.epoch;
      if (timeline.initialized && timeline.epoch === target.epoch) unavailable = false;
      if (replicaState.retiredEpochs.includes(target.epoch) || unavailable) {
        setValue({ id, state: 'unavailable', progress });
        return;
      }
      const applied = timeline.initialized && timeline.epoch === target.epoch ? timeline.nextSeq - 1 : undefined;
      complete = applied !== undefined && applied >= target.seq;
      progress = complete ? 1 : Math.max(progress, applied === undefined ? 0 : Math.max(0, (applied - start) / Math.max(1, target.seq - start)));
      setValue(previous => previous?.id === id && previous.progress === progress && previous.state === (complete ? 'complete' : 'catching_up')
        ? previous : { id, state: complete ? 'complete' : 'catching_up', progress });
    };
    const stopReplica = replica.subscribe(() => update());
    const stopHistory = replica.subscribeHistory(update);
    release.current = () => { stopReplica(); stopHistory(); };
    update();
  }, []);
  useEffect(() => () => { ++generation.current; release.current?.(); }, []);
  const focus = useCallback((replica?: AgentReplica) => {
    if (targetReplica.current && targetReplica.current !== replica) begin();
  }, [begin]);
  return { value, begin, focus };
}
