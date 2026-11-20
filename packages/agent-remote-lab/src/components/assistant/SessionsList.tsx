import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { controllerPath } from '@orchardworks/agent-remote-protocol/model';
import type { SessionSuccessionHistoryNavigation } from '@orchardworks/agent-client';
import type { AgentChildSessionView } from '@orchardworks/agent-client-web/react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { knownTitle, sessionKey, type SessionEntry } from '../../session-tree.js';

/** The sessions behind an assistant: its handoff chain, its subagents, and the identity of the session on screen. */
export interface AssistantSessions {
  /** The handoff chain of the session on screen, and how a session of it opens (in the view, as history for an earlier one). */
  readonly chain?: { readonly navigation?: SessionSuccessionHistoryNavigation; open(session: SessionEntry, intent?: 'history'): Promise<boolean> };
  readonly subagents?: readonly AgentChildSessionView[];
  openSubagent?(child: AgentChildSessionView): void | Promise<void>;
  /** The working directory and session id, copyable, and the session's own links (star, session link, VS Code). */
  readonly directory?: string;
  readonly sessionId?: string;
  readonly tools?: ReactNode;
}

/**
 * The Sessions list of the details (I3 plan, H4, H5, W1, W2): the chain newest first with the current one marked and Return
 * to current while an earlier one shows, the subagent sessions, then the working directory and session id with Copy.
 */
export function SessionsList({ sessions }: { sessions: AssistantSessions }) {
  const t = useTranslate();
  const navigation = sessions.chain?.navigation;
  const [pending, setPending] = useState(false), [error, setError] = useState<string>();
  const opening = useRef(false);
  const shown = navigation?.session;
  const chain: Array<{ session: SessionEntry; current: boolean; intent?: 'history' }> = navigation
    ? navigation.history
      ? [{ session: navigation.current, current: true }, { session: navigation.session, current: false, intent: 'history' },
        ...(navigation.predecessor ? [navigation.predecessor] : []).concat(navigation.ancestors).map(session => ({ session, current: false, intent: 'history' as const }))]
      : [{ session: navigation.session, current: true }, ...(navigation.predecessor ? [navigation.predecessor] : []).concat(navigation.ancestors).map(session => ({ session, current: false, intent: 'history' as const }))]
    : [];
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
    return <a href={href} onClick={event => void open(event)} aria-disabled={pending || undefined} title={target.title}>{label}</a>;
  }
  return <div className="lab-assistant-sessions" aria-busy={pending || undefined}>
    {chain.length > 1 ? <ol className="lab-assistant-chain" aria-label={t('details.sessions')}>
      {chain.map(({ session, current, intent }) => {
        const title = knownTitle(session) ?? session.nativeSessionId;
        const onScreen = shown && sessionKey(session) === sessionKey(shown);
        return <li key={sessionKey(session)} aria-current={onScreen ? 'true' : undefined}>
          {onScreen ? <span title={session.title}>{title}</span> : link(session, title, intent)}
          {current ? <small>{t('details.current')}</small> : null}
        </li>;
      })}
    </ol> : null}
    {navigation?.history ? <p className="lab-assistant-return">{link(navigation.current, t('details.returnToCurrent'))}</p> : null}
    {sessions.subagents?.length ? <><h4>{t('details.subagents')}</h4><ul className="lab-assistant-subagents">
      {sessions.subagents.map(child => <li key={child.nativeSessionId}><button type="button" onClick={() => void sessions.openSubagent?.(child)}>{child.title || child.nativeSessionId}</button></li>)}
    </ul></> : null}
    <dl className="lab-assistant-identity">
      {sessions.directory ? <Copyable label={t('details.directory')} value={sessions.directory} /> : null}
      {sessions.sessionId ? <Copyable label={t('details.sessionId')} value={sessions.sessionId} /> : null}
    </dl>
    {sessions.tools ? <div className="lab-assistant-session-tools">{sessions.tools}</div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}

function Copyable({ label, value }: { label: string; value: string }) {
  const t = useTranslate();
  return <div><dt>{label}</dt><dd><code>{value}</code>
    <button type="button" className="lab-assistant-copy" aria-label={t('details.copy', { what: label })} title={t('details.copy', { what: label })}
      onClick={() => void navigator.clipboard?.writeText(value).catch(() => {})}>⧉</button></dd></div>;
}
