import type { OpenedSession } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';
import type { SessionFork } from '../session-forks.js';

export function ForkIcon() {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="4" cy="3" r="1.75" /><circle cx="12" cy="3" r="1.75" /><circle cx="4" cy="13" r="1.75" /><path d="M4 4.75v6.5M12 4.75v1a3 3 0 0 1-3 3H4" /></svg>;
}
export function ForkReference({ fork, onOpen }: { fork: SessionFork; onOpen(session: OpenedSession): void }) {
  return <details className="lab-fork-reference">
    <summary className="agent-skill-tag" title={`Context from ${fork.source.nativeSessionId}`}>
      <span className="lab-fork-symbol" aria-hidden="true">&amp;<span><ForkIcon /></span></span>
      <span className="lab-fork-title">{fork.source.title}</span>
    </summary>
    <div className="lab-fork-reference-details">
      <strong>Context from {fork.source.title}</strong>
      {fork.mode === 'reference' ? <p>Source reference · Read on demand. New source messages may be read.</p> : <>
      <p>Fixed snapshot · {fork.itemCount} items · {new Date(fork.capturedAt).toLocaleString()}</p>
      <p>Later source messages are not included.</p>
      {fork.shortenedToolCount ? <p>{fork.shortenedToolCount} tool records shortened. User and assistant messages are preserved.</p> : null}
      <small>Boundary {fork.boundary.epoch} / {fork.boundary.seq}</small>
      </>}
      <code>{fork.source.nativeSessionId}</code>
      <button type="button" onClick={() => onOpen(fork.source)}>Open source session</button>
    </div>
  </details>;
}
export function ForkEntries({ forks, onOpen, selectedChild }: { forks: readonly SessionFork[]; onOpen(fork: SessionFork): void; selectedChild?: string | null }) {
  if (!forks.length) return null;
  return <nav className="lab-fork-entries" aria-label="Forked sessions"><span className="lab-side-list-label">Sides · {forks.length}</span>{forks.map((fork, index) => {
    const label = `Side ${index + 1} · ${fork.firstInput?.trim().slice(0, 72) || fork.target?.title || 'New session'}`;
    return <button type="button" key={fork.id} aria-pressed={!!fork.target && selectedChild === sessionKey(fork.target)}
      title={label} onClick={() => onOpen(fork)}><ForkIcon /><span>{label}</span></button>;
  })}</nav>;
}
