import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { RemoteChainClient } from '@orchardworks/agent-client';
import type { BotChain, ChainAction, ChainThresholds, ChainView } from '@orchardworks/agent-remote-protocol';
import { LocaleContext, useTranslate } from '@orchardworks/agent-client-web/react';
import { markChainsSeen, observeChains } from '../../kernel/chain-alerts.js';
import { workspaceFetch } from '../../kernel/workspace-access.js';
import { dateLocale, replyTime } from '../../kernel/reply-time.js';
import { SessionRow } from '../../conversation/assistant/SessionsList.js';
import '../../conversation/assistant/assistant.css';

const REFRESH_MS = 10_000;

/**
 * The audit (bots design 7): each chain the person's inputs and the bots' timers set off, newest first, with what it did, and the
 * person's decisions on it: stop it, stop one bot's part, pause or resume a standing bot, and revoke what the person allowed for the rest of a chain (plan 9d). It refreshes while
 * the page is visible.
 */
export function BotAudit({ baseUrl, client: given }: { baseUrl: string; client?: Pick<RemoteChainClient, 'list' | 'act'> }) {
  const t = useTranslate();
  const locale = useContext(LocaleContext);
  const client = useMemo(() => given ?? new RemoteChainClient(baseUrl, workspaceFetch), [baseUrl, given]);
  const [view, setView] = useState<ChainView>();
  const [failed, setFailed] = useState(false), [busy, setBusy] = useState(false);
  // What the audit shows is seen: the chains that passed a threshold stop marking their bots and counting on Settings.
  const load = useCallback(async () => { try { const next = await client.list(); setView(next); observeChains(baseUrl, next.chains); markChainsSeen(baseUrl); } catch { setFailed(true); } }, [client, baseUrl]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  const act = async (action: ChainAction) => {
    if (busy) return;
    setBusy(true); setFailed(false);
    try { await client.act(action); } catch { setFailed(true); } finally { setBusy(false); await load(); }
  };
  if (!view) return failed ? <p role="alert">{t('client.error.auditUnavailable')}</p> : null;
  const name = (bot: string) => view.names[bot] ?? bot.slice(0, 10);
  const cause = (chain: BotChain) => t(`settings.audit.cause.${chain.cause}`, { bot: name(chain.bot) });
  const passed = (chain: BotChain) => chain.passed?.length ? t('settings.audit.passed', { what: chain.passed.map(item => t(`settings.audit.threshold.${item}`)).join(', ') }) : undefined;
  const button = (label: string, action: ChainAction) => <button type="button" className="lab-assistant-action" disabled={busy} onClick={() => void act(action)}>{label}</button>;
  return <div className="lab-assistant-sessions lab-bot-audit">
    <Thresholds saved={view.thresholds} busy={busy} save={thresholds => void act({ action: 'set_thresholds', thresholds })} />
    {view.chains.length ? <ul className="lab-assistant-chain">{view.chains.map(chain => <SessionRow key={chain.id} title={cause(chain)}
      meta={[replyTime(chain.updatedAt, undefined, dateLocale(locale), t), chain.stopped !== undefined ? t('settings.audit.stopped') : undefined, passed(chain),
        t('settings.audit.counts', { messages: chain.messages, turns: chain.turns, created: chain.created, subSessions: chain.subSessions ?? 0, depth: chain.depth, tokens: chain.usage.tokens.toLocaleString(locale) })]}
      heading={<span className="lab-assistant-session-title">{cause(chain)}</span>}>
      {chain.stopped === undefined ? <div className="lab-assistant-task-actions">{button(t('settings.audit.stop'), { action: 'stop', chainId: chain.id })}</div> : null}
      {chain.approvals?.length ? <section className="lab-bot-audit-approvals" aria-label={t('settings.audit.approvals')}>
        <h4>{t('settings.audit.approvals')}</h4>
        <ul>{chain.approvals.map(approval => <li key={approval.cwd}>
          <span>{t('settings.audit.approval', { folder: approval.cwd })}</span>
          <small>{[replyTime(approval.at, undefined, dateLocale(locale), t), t('settings.audit.approvalApplied', { count: approval.applied })].join(' · ')}</small>
          <div className="lab-assistant-task-actions">{button(t('settings.audit.revoke'), { action: 'revoke_approval', chainId: chain.id, cwd: approval.cwd })}</div>
        </li>)}</ul>
      </section> : null}
      <ul className="lab-bot-audit-bots">{chain.bots.map(bot => {
        const paused = view.paused.includes(bot);
        return <li key={bot}><span>{name(bot)}{paused ? ` · ${t('settings.audit.paused')}` : ''}</span>
          <div className="lab-assistant-task-actions">
            {chain.stopped === undefined && !chain.stoppedBots?.includes(bot) ? button(t('settings.audit.stopBot', { bot: name(bot) }), { action: 'stop_bot', chainId: chain.id, botId: bot }) : null}
            {button(t(paused ? 'settings.audit.resume' : 'settings.audit.pause', { bot: name(bot) }), { action: paused ? 'resume_bot' : 'pause_bot', botId: bot })}
          </div></li>;
      })}</ul>
    </SessionRow>)}</ul> : <p>{t('settings.audit.empty')}</p>}
    {failed ? <p role="alert">{t('settings.audit.failed')}</p> : null}
  </div>;
}

const THRESHOLDS = ['tokens', 'depth', 'minutes'] as const;
/** The person's thresholds: a number each, or empty for none. */
function Thresholds({ saved, busy, save }: { saved: ChainThresholds; busy: boolean; save(thresholds: ChainThresholds): void }) {
  const t = useTranslate();
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(THRESHOLDS.map(key => [key, saved[key] === undefined ? '' : String(saved[key])])));
  const next: ChainThresholds = Object.fromEntries(THRESHOLDS.flatMap(key => { const value = Number.parseInt(draft[key] ?? '', 10); return value > 0 ? [[key, value]] : []; }));
  const changed = THRESHOLDS.some(key => next[key] !== saved[key]);
  return <form className="lab-bot-audit-thresholds" aria-label={t('settings.audit.thresholds')} onSubmit={event => { event.preventDefault(); save(next); }}>
    <h4>{t('settings.audit.thresholds')}</h4>
    <p className="lab-setting-note">{t('settings.audit.thresholds.hint')}</p>
    {THRESHOLDS.map(key => <label key={key}>{t(`settings.audit.threshold.${key}`)}
      <input type="number" min={1} inputMode="numeric" value={draft[key]} onChange={event => setDraft(current => ({ ...current, [key]: event.target.value }))} /></label>)}
    <button type="submit" className="lab-assistant-action" disabled={busy || !changed}>{t('common.save')}</button>
  </form>;
}
