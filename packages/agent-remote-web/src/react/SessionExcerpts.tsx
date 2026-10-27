import { createContext, useContext } from 'react';
import { splitSessionExcerpts, type AgentTimelineItem, type SessionExcerpt } from '@orchardworks/agent-remote-protocol';

/** Opens the session an excerpt was quoted from; without it, an excerpt only names its source. */
export const SessionExcerptNavigation = createContext<((source: SessionExcerpt['source']) => void | Promise<void>) | undefined>(undefined);

type UserMessage = Extract<AgentTimelineItem, { type: 'user_message' }>;
/** The user's own message with the excerpts it carries at its end taken out. */
export function withoutSessionExcerpts(item: UserMessage): { item: UserMessage; excerpts: SessionExcerpt[] } {
  const last = item.content?.at(-1);
  if (item.content && last?.type === 'text') {
    const split = splitSessionExcerpts(last.text);
    if (!split.excerpts.length) return { item, excerpts: [] };
    const content = split.text ? [...item.content.slice(0, -1), { ...last, text: split.text }] : item.content.slice(0, -1);
    return { item: { ...item, text: splitSessionExcerpts(item.text).text, content }, excerpts: split.excerpts };
  }
  const split = splitSessionExcerpts(item.text);
  return split.excerpts.length ? { item: { ...item, text: split.text }, excerpts: split.excerpts } : { item, excerpts: [] };
}

export function excerptMessageCount(excerpt: SessionExcerpt): number {
  return excerpt.segments.reduce((total, segment) => total + segment.length, 0);
}

/** Quoted excerpts read as attachments of the message, collapsed to their source until opened. */
export function SessionExcerptList({ excerpts }: { excerpts: readonly SessionExcerpt[] }) {
  const navigate = useContext(SessionExcerptNavigation);
  if (!excerpts.length) return null;
  return <ul className="agent-session-excerpts" aria-label="Quoted excerpts">
    {excerpts.map(excerpt => {
      const count = excerptMessageCount(excerpt);
      return <li key={excerpt.id}><details className="agent-session-excerpt">
        <summary>
          <span className="agent-session-excerpt-kicker">Quoted</span>
          <span className="agent-session-excerpt-title">{excerpt.source.title || 'Untitled session'}</span>
          <span className="agent-session-excerpt-count">{count} {count === 1 ? 'message' : 'messages'}{excerpt.segments.length > 1 ? ` in ${excerpt.segments.length} parts` : ''}</span>
        </summary>
        <div className="agent-session-excerpt-body">
          {navigate ? <button type="button" className="agent-session-excerpt-open" onClick={() => void navigate(excerpt.source)}>Open source session</button> : null}
          {excerpt.segments.map((segment, index) => <ol key={index} className="agent-session-excerpt-segment">
            {segment.map((row, rowIndex) => <li key={rowIndex} data-role={row.role}>
              <span className="agent-session-excerpt-role">{row.role === 'user' ? 'User' : row.role === 'assistant' ? 'Assistant' : 'Tool'}</span>
              <span className="agent-session-excerpt-text">{row.role === 'tool' ? toolSummary(row.text) : row.text}</span>
            </li>)}
          </ol>)}
        </div>
      </details></li>;
    })}
  </ul>;
}

function toolSummary(text: string): string {
  try {
    const value = JSON.parse(text) as { name?: unknown; status?: unknown };
    return [typeof value.name === 'string' ? value.name : 'Tool call', typeof value.status === 'string' ? value.status : ''].filter(Boolean).join(' · ');
  } catch { return 'Tool call'; }
}
