import { TimelineTitle } from '../TimelineTitle.js';
import { useTranslate } from '../locale.js';
import type { AgentTaskItem, AgentTimelineItem } from '@orchardworks/agent-remote-protocol';

function status(item: AgentTaskItem): 'pending' | 'in_progress' | 'completed' {
  if (item.status) return item.status;
  return item.completed ? 'completed' : 'pending';
}

const labelKeys = { pending: 'timeline.state.pending', in_progress: 'timeline.state.inProgress', completed: 'timeline.state.completed' } as const;

export function TodoItem({ item }: { readonly item: Extract<AgentTimelineItem, { type: 'todo' }> }) {
  const t = useTranslate();
  return <article className="agent-timeline-item agent-todo">
    <header className="agent-item-header"><span className="agent-item-kicker">{t('timeline.todo.board')}</span><TimelineTitle><strong>{t('timeline.todo.plan')}</strong></TimelineTitle></header>
    <ol>{item.items.map((task, index) => {
      const current = status(task);
      return <li key={task.id ?? `${task.text}-${index}`} className={`agent-state-${current}`}>
        <span className="agent-todo-mark" aria-hidden="true">{current === 'completed' ? '✓' : current === 'in_progress' ? '→' : '·'}</span>
        <span>{task.text}</span><small>{t(labelKeys[current])}</small>
      </li>;
    })}</ol>
  </article>;
}
