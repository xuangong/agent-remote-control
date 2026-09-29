import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentReplicaState } from '../replica/types.js';
import { findTimelineMatches, type TimelineSearchMatch, type TimelineSearchProgress, type TimelineSearchScope } from '../client/timeline-search.js';
import { timelineEntryKey } from '../replica/timeline-entry-key.js';
import type { SessionViewActions } from './session-view-actions.js';

interface SearchState extends TimelineSearchProgress {
  query: string;
  scope: TimelineSearchScope;
  phase: 'scanning' | 'complete' | 'partial' | 'error';
  error?: string;
}

/** Mount per session/epoch. Closing the panel cancels its scan and pending navigation. */
export function TimelineSearch({ state, search, onSelect, onClose, onClearSelection }: {
  state: AgentReplicaState;
  search?: SessionViewActions['searchTimeline'];
  onSelect(match: TimelineSearchMatch, signal: AbortSignal): Promise<void>;
  onClose(): void;
  onClearSelection?(): void;
}) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<TimelineSearchScope>('messages');
  const needle = query.trim();
  const [retry, setRetry] = useState(0);
  const [progress, setProgress] = useState<SearchState>({ query: '', scope: 'messages', matches: [], scanned: 0, phase: 'complete' });
  const [selected, setSelected] = useState<string>();
  const [jumping, setJumping] = useState(false);
  const [jumpError, setJumpError] = useState<string>();
  const [showResults, setShowResults] = useState(true);
  const [limit, setLimit] = useState(30);
  const scan = useRef<AbortController>();
  const jump = useRef<AbortController>();
  const latest = useRef({ state, search, onSelect, onClearSelection });
  latest.current = { state, search, onSelect, onClearSelection };
  const canSearch = !!search;

  useEffect(() => {
    const controller = new AbortController();
    scan.current = controller;
    jump.current?.abort();
    latest.current.onClearSelection?.();
    setSelected(undefined); setJumping(false); setJumpError(undefined); setLimit(30);
    setProgress({ query: needle, scope, matches: [], scanned: 0, phase: needle ? 'scanning' : 'complete' });
    if (!needle) return () => controller.abort();
    const timer = setTimeout(() => {
      if (controller.signal.aborted) return;
      const { state, search } = latest.current;
      if (!search) {
        setProgress({ query: needle, scope, matches: [], scanned: state.timeline.entries.length,
          phase: state.timeline.hasOlder ? 'partial' : 'complete' });
        return;
      }
      void Promise.resolve().then(() => search(needle, { scope, signal: controller.signal, onProgress: value => {
        if (!controller.signal.aborted) setProgress({ ...value, query: needle, scope, phase: 'scanning' });
      } })).then(value => {
        if (!controller.signal.aborted) setProgress({ ...value, query: needle, scope, phase: 'complete' });
      }, error => {
        if (!controller.signal.aborted) setProgress(previous => ({ ...previous, phase: 'error', error: error instanceof Error ? error.message : 'History search failed.' }));
      });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [needle, scope, canSearch, retry]);
  useEffect(() => () => { jump.current?.abort(); }, []);

  const loaded = useMemo(() => ({
    keys: new Set(state.timeline.entries.map(entry => timelineEntryKey(state.timeline.epoch, entry))),
    matches: state.timeline.epoch ? findTimelineMatches(state.timeline.epoch, state.timeline.entries, needle, scope) : [],
  }), [needle, scope, state.timeline.entries, state.timeline.epoch]);
  const matches = useMemo(() => {
    if (!needle) return [];
    const older = progress.query === needle && progress.scope === scope ? progress.matches.filter(match => !loaded.keys.has(match.key)) : [];
    return [...older, ...loaded.matches].sort((a, b) => b.seq - a.seq);
  }, [needle, scope, loaded, progress.matches, progress.query, progress.scope]);
  const index = matches.findIndex(match => match.key === selected);
  const phase = progress.query === needle && progress.scope === scope ? progress.phase : 'scanning';

  async function choose(match: TimelineSearchMatch) {
    jump.current?.abort();
    const controller = new AbortController(); jump.current = controller;
    setSelected(match.key); setJumping(true); setJumpError(undefined);
    try {
      await latest.current.onSelect(match, controller.signal);
      if (!controller.signal.aborted) setShowResults(false);
    } catch (error) {
      if (!controller.signal.aborted) setJumpError(error instanceof Error ? error.message : 'This result could not be opened.');
    } finally { if (!controller.signal.aborted) setJumping(false); }
  }
  function move(direction: number) {
    const match = matches[(index < 0 ? (direction > 0 ? 0 : matches.length - 1) : index + direction + matches.length) % matches.length];
    if (match) void choose(match);
  }

  return <section className="agent-session-search" aria-label="Search this session" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  }}>
    <div className="agent-session-search-input">
      <input autoFocus type="search" aria-label="Search session history" placeholder="Search this session…" value={query}
        onChange={event => { setQuery(event.target.value); setShowResults(true); }}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
        }} />
      <button type="button" aria-label="Previous search result" title="Previous result (Shift+Enter)" disabled={!matches.length || jumping} onClick={() => move(-1)}>↑</button>
      <button type="button" aria-label="Next search result" title="Next result (Enter)" disabled={!matches.length || jumping} onClick={() => move(1)}>↓</button>
      <button type="button" aria-label="Close session search" onClick={onClose}>×</button>
    </div>
    <select aria-label="Search scope" value={scope} onChange={event => { setScope(event.target.value as TimelineSearchScope); setShowResults(true); }}>
      <option value="messages">User / Assistant messages</option><option value="all">All activity</option>
      <option value="tools">Tool calls</option><option value="reasoning">Reasoning</option>
    </select>
    {needle ? <>
      <div className="agent-session-search-status">
        <button type="button" disabled={!matches.length} aria-expanded={showResults} onClick={() => setShowResults(value => !value)}>
          {index >= 0 ? `${index + 1} / ` : ''}{matches.length} matching {matches.length === 1 ? 'message' : 'messages'}
        </button>
        <span role="status">{jumping ? 'Loading result…' : phase === 'scanning' ? `Searching history… ${progress.scanned} checked`
          : phase === 'complete' ? 'All available history searched' : 'Partial results'}</span>
        {phase === 'scanning' ? <button type="button" onClick={() => {
          scan.current?.abort(); setProgress(previous => ({ ...previous, phase: 'partial' }));
        }}>Stop</button> : phase !== 'complete' && canSearch ? <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button> : null}
      </div>
      {progress.error || jumpError ? <p className="agent-history-error" role="alert">{jumpError ?? progress.error}</p> : null}
      {phase === 'partial' && !canSearch ? <p className="agent-session-search-note">Only loaded history is available until the session reconnects.</p> : null}
      {showResults && matches.length > 0 ? <ol className="agent-session-search-results">
        {matches.slice(0, limit).map(match => <li key={match.key}>
          <button type="button" aria-current={match.key === selected || undefined} disabled={jumping} onClick={() => { void choose(match); }}>
            <span className="agent-session-search-meta">{match.label}<time dateTime={match.timestamp}>{new Date(match.timestamp).toLocaleString()}</time></span>
            <span><SearchSnippet text={match.snippet} query={needle} /></span>
          </button>
        </li>)}
        {matches.length > limit ? <li><button type="button" onClick={() => setLimit(value => value + 30)}>Show more results</button></li> : null}
      </ol> : null}
    </> : <p className="agent-session-search-note">Search the selected message types across available history.</p>}
  </section>;
}

function SearchSnippet({ text, query }: { text: string; query: string }) {
  const normalized = query.replace(/\s+/g, ' ');
  const offset = text.toLowerCase().indexOf(normalized.toLowerCase());
  if (offset < 0) return <>{text}</>;
  return <>{text.slice(0, offset)}<mark>{text.slice(offset, offset + normalized.length)}</mark>{text.slice(offset + normalized.length)}</>;
}
