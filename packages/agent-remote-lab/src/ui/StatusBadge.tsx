export type RowStatus = { kind: 'attention'; count: number } | { kind: 'failed' } | { kind: 'working' } | { kind: 'unread' };

const NAMES = { failed: 'Failed', working: 'Working', unread: 'New result' } as const;

/** One trailing status of a row: a count of requests that need you, a failure, work in progress or a new result. */
export function StatusBadge({ status }: { status: RowStatus }) {
  const name = status.kind === 'attention' ? `Needs you: ${status.count}` : NAMES[status.kind];
  const text = status.kind === 'attention' ? (status.count > 99 ? '99+' : String(status.count)) : status.kind === 'failed' ? '!' : '';
  return <span className="ui-status" data-kind={status.kind} role="img" aria-label={name}>{text}</span>;
}
