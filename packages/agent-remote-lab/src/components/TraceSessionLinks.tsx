import { useState } from 'react';
import type { AgentTimelineItem } from '@agent-remote-controller/agent-remote-protocol';
import type { SessionLinkResolver } from '@agent-remote-controller/agent-remote-web/react';
import { traceSessionReferences } from '../trace-model.js';

export function TraceSessionLinks({ item, resolveSessionLink }: { item: AgentTimelineItem; resolveSessionLink?: SessionLinkResolver }) {
  const [failure, setFailure] = useState<string>();
  const references = traceSessionReferences(item);
  if (!references.length) return null;
  return <div className="lab-trace-session-links">
    {references.map(reference => {
      const destination = resolveSessionLink?.(reference.nativeSessionId);
      const title = reference.title === reference.nativeSessionId ? destination?.title || reference.title : reference.title;
      return destination ? <a key={reference.nativeSessionId} href={destination.href} title={reference.nativeSessionId} onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        setFailure(undefined);
        void destination.open().catch(error => setFailure(error instanceof Error ? error.message : 'This session could not be opened.'));
      }}>{title}</a> : <span key={reference.nativeSessionId} title={reference.nativeSessionId}>{title}</span>;
    })}
    {failure ? <p role="alert">{failure}</p> : null}
  </div>;
}
