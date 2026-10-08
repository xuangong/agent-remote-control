import type { AgentStatus } from '@orchardworks/agent-remote-protocol';

/** The shell decides which session title exposes its native rename action. */
export function SessionTitle({ title, status, className = '', current, as: Element = 'strong', onRename }: {
  title: string; status?: AgentStatus; className?: string; current?: boolean; as?: 'strong' | 'span'; onRename?(): void;
}) {
  return <Element className={`agent-session-title ${className}`} data-session-status={status} aria-current={current ? 'page' : undefined}
    role={onRename ? 'button' : undefined} tabIndex={onRename ? 0 : undefined}
    title={onRename ? `${title} — Double-click to rename session` : title} aria-keyshortcuts={onRename ? 'F2' : undefined}
    onDoubleClick={onRename ? event => { event.stopPropagation(); onRename(); } : undefined}
    onKeyDown={onRename ? event => {
      if (!['F2', 'Enter', ' '].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault(); event.stopPropagation(); onRename();
    } : undefined}>{title}</Element>;
}
