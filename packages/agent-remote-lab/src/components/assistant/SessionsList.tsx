import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { controllerPath } from '@orchardworks/agent-remote-protocol/model';
import type { SessionSuccessionHistoryNavigation } from '@orchardworks/agent-client';
import type { AgentChildSessionView } from '@orchardworks/agent-client-web/react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { knownTitle, sessionKey, type SessionEntry } from '../../session-tree.js';
import { replyTime } from '../../reply-time.js';
import { SessionLink } from '../SessionLink.js';
import { Icon } from '../../ui/Icon.js';

/** The sessions behind an assistant: its handoff chain, its subagents, and the identity of the session on screen. */
export interface AssistantSessions {
  /** The handoff chain of the session on screen, and how a session of it opens (in the view, as history for an earlier one). */
  readonly chain?: { readonly navigation?: SessionSuccessionHistoryNavigation; open(session: SessionEntry, intent?: 'history'): Promise<boolean> };
  /** The session on screen when there is no chain. */
  readonly session?: SessionEntry;
  /** When the session on screen last had a turn (ms). */
  readonly time?: number;
  readonly subagents?: readonly AgentChildSessionView[];
  openSubagent?(child: AgentChildSessionView): void | Promise<void>;
  /** The working directory and the reported id of the session on screen, and its own links (VS Code, the session link). */
  readonly directory?: string;
  readonly sessionId?: string;
  readonly tools?: ReactNode;
}

type Row = { session: SessionEntry; current: boolean; intent?: 'history' };

/**
 * The Sessions of the details (I3 plan, H4, H5, W1, W2): one compact row per session, newest first, with its title, time and
 * state; a row opens its session, and its chevron shows the session's working directory, ID, VS Code and link. Return to
 * current shows while an earlier one is on screen; the subagent sessions follow.
 */
export function SessionsList({ sessions }: { sessions: AssistantSessions }) {
  const t = useTranslate();
  const navigation = sessions.chain?.navigation;
  const [pending, setPending] = useState(false), [error, setError] = useState<string>();
  const opening = useRef(false);
  const shown = navigation?.session ?? sessions.session;
  const earlier = (session: SessionEntry): Row => ({ session, current: false, intent: 'history' });
  const rows: Row[] = navigation
    ? navigation.history
      ? [{ session: navigation.current, current: true }, earlier(navigation.session), ...(navigation.predecessor ? [navigation.predecessor] : []).concat(navigation.ancestors).map(earlier)]
      : [{ session: navigation.session, current: true }, ...(navigation.predecessor ? [navigation.predecessor] : []).concat(navigation.ancestors).map(earlier)]
    : sessions.session ? [{ session: sessions.session, current: true }] : [];
  function link(target: SessionEntry, label: string, intent?: 'history') {
    const href = controllerPath({ hostId: target.hostId ?? 'local', providerId: target.providerId, nativeSessionId: target.nativeSessionId, sessionIntent: intent });
    async function open(event: MouseEvent<HTMLAnchorElement>) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !sessions.chain) return;
      event.preventDefault();
      if (opening.current) return;
      opening.current = true; setPending(true); setError(undefined);
      try { if (!await sessions.chain.open(target, intent)) setError('This session could not be opened.'); }
      catch (reason) { setError(reason instanceof Error ? reason.message : 'This session could not be opened.'); }
      finally { opening.current = false; setPending(false); }
    }
    return <a className="lab-assistant-session-title" href={href} onClick={event => void open(event)} aria-disabled={pending || undefined} title={target.title}>{label}</a>;
  }
  return <div className="lab-assistant-sessions" aria-busy={pending || undefined}>
    {rows.length ? <ol className="lab-assistant-chain" aria-label={t('details.sessions')}>
      {rows.map(({ session, current, intent }) => {
        const title = knownTitle(session) ?? session.nativeSessionId;
        const onScreen = !!shown && sessionKey(session) === sessionKey(shown);
        return <SessionRow key={sessionKey(session)} title={title} onScreen={onScreen}
          meta={[onScreen && sessions.time ? replyTime(sessions.time) : undefined, current ? t('details.current') : t('details.earlierSession')]}
          heading={onScreen ? <span className="lab-assistant-session-title" title={session.title}>{title}</span> : link(session, title, intent)}>
          {onScreen && sessions.directory ? <Copyable label={t('details.directory')} value={sessions.directory} /> : null}
          <Copyable label={t('details.sessionId')} value={onScreen && sessions.sessionId ? sessions.sessionId : session.nativeSessionId} />
          <div className="lab-assistant-session-tools">{onScreen ? sessions.tools : <SessionLink session={{ ...session, hostId: session.hostId ?? 'local' }} sessionIntent={intent} />}</div>
        </SessionRow>;
      })}
    </ol> : null}
    {navigation?.history ? <p className="lab-assistant-return">{link(navigation.current, t('details.returnToCurrent'))}</p> : null}
    {sessions.subagents?.length ? <><h4>{t('details.subagents')}</h4><ul className="lab-assistant-chain lab-assistant-subagents">
      {sessions.subagents.map(child => <SessionRow key={child.nativeSessionId} title={child.title || child.nativeSessionId}
        meta={[child.createdAt ? replyTime(Date.parse(child.createdAt)) : undefined, childState(child.status, t)]}
        heading={<button type="button" className="lab-assistant-session-title" onClick={() => void sessions.openSubagent?.(child)}>{child.title || child.nativeSessionId}</button>}>
        <Copyable label={t('details.sessionId')} value={child.nativeSessionId} />
      </SessionRow>)}
    </ul></> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}

function childState(status: AgentChildSessionView['status'] | undefined, t: ReturnType<typeof useTranslate>): string | undefined {
  return status === 'running' || status === 'starting' ? t('state.working') : status === 'waiting' ? t('state.needsYou') : status === 'failed' ? t('state.failed')
    : status === 'closed' ? t('state.ended') : status === 'idle' ? t('state.idle') : undefined;
}

/** One session: its title, time and state on one line, and what its chevron shows. */
function SessionRow({ title, heading, meta, onScreen = false, children }: { title: string; heading: ReactNode; meta: ReadonlyArray<string | undefined>; onScreen?: boolean; children: ReactNode }) {
  const t = useTranslate();
  const [open, setOpen] = useState(false);
  const words = meta.filter(Boolean).join(' · ');
  return <li aria-current={onScreen ? 'true' : undefined}>
    <div className="lab-assistant-session">
      {heading}{words ? <small>{words}</small> : null}
      <button type="button" className="lab-assistant-session-toggle" aria-expanded={open} aria-label={t('details.sessionMore', { title })} onClick={() => setOpen(value => !value)}>
        <Icon name="chevron-down" size={14} /></button>
    </div>
    {open ? <div className="lab-assistant-identity">{children}</div> : null}
  </li>;
}

function Copyable({ label, value }: { label: string; value: string }) {
  const t = useTranslate();
  return <p><span>{label}</span><code>{value}</code>
    <button type="button" className="lab-assistant-copy" aria-label={t('details.copy', { what: label })} title={t('details.copy', { what: label })}
      onClick={() => void navigator.clipboard?.writeText(value).catch(() => {})}>⧉</button></p>;
}
