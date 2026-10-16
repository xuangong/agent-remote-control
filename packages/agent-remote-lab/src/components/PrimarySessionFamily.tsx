import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import type { NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import { SessionDirectoryClient } from '../directory-client.js';
import { useSuccessionContext } from '../hooks/useSuccessionContext.js';
import { WorkspaceReady } from '../workspace-access.js';
import { SessionFamily } from './SessionFamily.js';

type Props = ComponentProps<typeof SessionFamily> & { successionContext?: { operationId: string; target: NativeSessionRef } };

/** Each primary group restores its own first-input evidence without another succession coordinator. */
export function PrimarySessionFamily({ successionContext, ...props }: Props) {
  const ready = useContext(WorkspaceReady);
  const localDirectory = useMemo(() => new SessionDirectoryClient(props.baseUrl, undefined, props.target.hostId), [props.baseUrl, props.target.hostId]);
  const directory = props.directoryFor?.(props.target.hostId) ?? localDirectory;
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey(value => value + 1), []);
  const pendingInput = useRef<{ key: string; count: number }>();
  const matches = successionContext?.target.providerId === props.target.providerId && successionContext.target.nativeSessionId === props.target.nativeSessionId;
  const context = useSuccessionContext({ directory, operationId: matches ? successionContext.operationId : undefined,
    target: matches ? successionContext.target : undefined, enabled: ready && !props.offline, refreshKey });
  return <SessionFamily {...props} sessionPresentation={session => {
    const presentation = props.sessionPresentation?.(session);
    return session.isRoot && matches ? { ...presentation,
      onPendingInputChange: count => {
        presentation?.onPendingInputChange?.(count);
        const key = JSON.stringify([successionContext.operationId, session.viewId, session.session.hostId, session.session.providerId, session.session.nativeSessionId]);
        const previous = pendingInput.current;
        pendingInput.current = { key, count };
        if (previous?.key === key && previous.count > 0 && count === 0) refresh();
      },
      pendingFirstInputContext: context && context.state !== 'materialized' ? { state: context.state, onRetry: context.onRetry } : undefined,
    } : presentation ?? {};
  }} renderSessionFooter={session => <>
    {session.isRoot && matches ? <TimelineEvidence key={JSON.stringify([session.session.hostId, session.session.providerId, session.session.nativeSessionId, session.viewId])}
      epoch={session.state?.timeline.epoch} seqEnd={session.state?.timeline.entries.at(-1)?.seqEnd} onAdvance={refresh} /> : null}
    {props.renderSessionFooter?.(session)}
  </>} />;
}

function TimelineEvidence({ epoch, seqEnd, onAdvance }: { epoch?: string | null; seqEnd?: number; onAdvance(): void }) {
  const evidence = `${epoch}:${seqEnd}`;
  const previous = useRef(evidence);
  useEffect(() => {
    if (previous.current !== evidence) { previous.current = evidence; onAdvance(); }
  }, [evidence, onAdvance]);
  return null;
}
