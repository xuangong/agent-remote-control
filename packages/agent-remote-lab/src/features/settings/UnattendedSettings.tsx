import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { RemoteChainClient } from '@orchardworks/agent-client';
import { costWords } from '@orchardworks/agent-client';
import type { ChainAction, ModelRates, UnattendedBudget, UnattendedView } from '@orchardworks/agent-remote-protocol';
import { Toggle } from '@orchardworks/agent-client-web/primitives';
import { LocaleContext, useTranslate } from '@orchardworks/agent-client-web/react';
import { workspaceFetch } from '../../kernel/workspace-access.js';
import { dateLocale, replyTime } from '../../kernel/reply-time.js';
import { SettingsRow } from './SettingsRow.js';

type SetUnattended = Extract<ChainAction, { action: 'set_unattended' }>['patch'];
const REFRESH_MS = 15_000;
const BUDGET_FIELDS = ['perDay', 'perMonth', 'runsPerDay'] as const;
const RATE_FIELDS = ['input', 'cacheWrite', 'cacheRead', 'output'] as const;

/**
 * Unattended work (routines design 10.2): the pause switch, the budget in estimated cost, what was used today and this month by bot,
 * the provider usage limits that stand, and the price table the estimate uses. Costs are "≈ $", API-equivalent.
 */
export function UnattendedSettings({ baseUrl, client: given }: { baseUrl: string; client?: Pick<RemoteChainClient, 'list' | 'act'> }) {
  const t = useTranslate(), locale = useContext(LocaleContext);
  const client = useMemo(() => given ?? new RemoteChainClient(baseUrl, workspaceFetch), [given, baseUrl]);
  const [view, setView] = useState<{ unattended: UnattendedView; names: Record<string, string> }>();
  const [failed, setFailed] = useState(false), [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { const next = await client.list(); if (next.unattended) setView({ unattended: next.unattended, names: next.names }); } catch { setFailed(true); } }, [client]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  const patch = async (change: SetUnattended) => {
    if (busy) return;
    setBusy(true); setFailed(false);
    try { await client.act({ action: 'set_unattended', patch: change }); } catch { setFailed(true); } finally { setBusy(false); await load(); }
  };
  if (!view) return failed ? <p role="alert">{t('routines.unattended.failed')}</p> : null;
  const { unattended: state } = view, settings = state.settings;
  const name = (bot: string) => view.names[bot] ?? bot.slice(0, 10);
  const money = (usd: number) => costWords(usd, locale);
  return <div className="lab-unattended">
    <SettingsRow label={t('routines.unattended.pause')} hint={t('routines.unattended.pauseHint')}>
      <Toggle label={t('routines.unattended.pause')} checked={!!settings.paused} onChange={paused => void patch({ paused })} />
    </SettingsRow>
    {state.absent ? <p className="lab-setting-note" role="status">{t('routines.unattended.absent')}</p> : null}
    {state.tripped.map(item => <p key={`${item.scope}:${item.period}`} className="lab-setting-note" role="status">
      {t('routines.unattended.tripped', { scope: item.scope === 'account' ? t('routines.unattended.tripped.account') : name(item.scope), period: t(`routines.unattended.tripped.${item.period}` as const) })}
      {item.period === 'day' ? <> <button type="button" className="lab-assistant-action" disabled={busy} onClick={() => void patch({ allowMoreToday: 5 })}>{t('routines.unattended.allowMore', { amount: '$5' })}</button></> : null}
    </p>)}
    <Budget key={JSON.stringify(settings.budget ?? {})} saved={settings.budget ?? {}} busy={busy} save={budget => void patch({ budget })} />
    <section className="lab-bot-audit-thresholds" aria-label={t('routines.unattended.usage')}>
      <h4>{t('routines.unattended.usage')}</h4>
      {(['today', 'month'] as const).map(period => {
        const usage = state[period], rows = Object.entries(usage.bots);
        return <div key={period}><h5>{t(`routines.unattended.usage.${period}` as const)} · {money(usage.usd)}</h5>
          {rows.length ? <ul>{rows.map(([bot, row]) => <li key={bot}><span>{name(bot)}</span> <small>{t('routines.unattended.usage.row', { cost: money(row.usd), tokens: row.tokens.toLocaleString(locale), runs: row.runs })}</small></li>)}</ul>
            : <p className="lab-assistant-empty">{t('routines.unattended.usage.empty')}</p>}</div>;
      })}
    </section>
    {state.limits.length ? <section aria-label={t('routines.unattended.limits')}><h4>{t('routines.unattended.limits')}</h4>
      <ul>{state.limits.map(limit => <li key={limit.provider}>{limit.resetsAt !== undefined ? t('routines.unattended.limit', { provider: limit.provider.split('/')[1] ?? limit.provider, when: replyTime(limit.resetsAt, undefined, dateLocale(locale), t) })
        : t('routines.unattended.limit.unknown', { provider: limit.provider.split('/')[1] ?? limit.provider })}</li>)}</ul></section> : null}
    <Prices prices={settings.prices ?? {}} unpriced={state.unpriced} busy={busy} save={prices => void patch({ prices })} />
    <Basics key={`${settings.timeZone ?? ''}:${settings.absenceDays ?? ''}`} zone={state.timeZone} absenceDays={settings.absenceDays ?? 14} busy={busy} save={basics => void patch(basics)} />
    {failed ? <p role="alert">{t('routines.unattended.failed')}</p> : null}
  </div>;
}

function Budget({ saved, busy, save }: { saved: UnattendedBudget; busy: boolean; save(budget: UnattendedBudget | null): void }) {
  const t = useTranslate();
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(BUDGET_FIELDS.map(key => [key, saved[key] === undefined ? '' : String(saved[key])])));
  const next: UnattendedBudget = Object.fromEntries(BUDGET_FIELDS.flatMap(key => { const value = Number(draft[key]); return draft[key] !== '' && Number.isFinite(value) && value > 0 ? [[key, key === 'runsPerDay' ? Math.floor(value) : value]] : []; }));
  const changed = BUDGET_FIELDS.some(key => next[key] !== saved[key]);
  return <form className="lab-bot-audit-thresholds" aria-label={t('routines.unattended.budget')} onSubmit={event => { event.preventDefault(); save(Object.keys(next).length ? next : null); }}>
    <h4>{t('routines.unattended.budget')}</h4>
    <p className="lab-setting-note">{t('routines.unattended.budget.hint')}</p>
    {BUDGET_FIELDS.map(key => <label key={key}>{t(`routines.unattended.${key}` as const)}
      <input type="number" min={0} step={key === 'runsPerDay' ? 1 : 'any'} inputMode="decimal" value={draft[key]} onChange={event => setDraft(current => ({ ...current, [key]: event.target.value }))} /></label>)}
    <button type="submit" className="lab-assistant-action" disabled={busy || !changed}>{t('routines.unattended.save')}</button>
  </form>;
}

function Prices({ prices, unpriced, busy, save }: { prices: Record<string, ModelRates>; unpriced: readonly string[]; busy: boolean; save(prices: Record<string, ModelRates | null>): void }) {
  const t = useTranslate();
  const [model, setModel] = useState(''), [rates, setRates] = useState<Record<string, string>>({ input: '', cacheWrite: '', cacheRead: '', output: '' });
  const parsed = Object.fromEntries(RATE_FIELDS.map(key => [key, Number(rates[key])])) as ModelRates;
  const valid = !!model.trim() && RATE_FIELDS.every(key => rates[key] !== '' && Number.isFinite(parsed[key]) && parsed[key] >= 0);
  return <section className="lab-bot-audit-thresholds" aria-label={t('routines.unattended.prices')}>
    <h4>{t('routines.unattended.prices')}</h4>
    <p className="lab-setting-note">{t('routines.unattended.prices.hint')}</p>
    {unpriced.length ? <p className="lab-setting-note" role="status">{t('routines.unattended.unpriced', { models: unpriced.join(', ') })}</p> : null}
    {Object.keys(prices).length ? <ul>{Object.entries(prices).map(([id, row]) => <li key={id}><span>{id}</span> <small>{RATE_FIELDS.map(key => row[key]).join(' / ')}</small>
      <button type="button" className="lab-assistant-action" disabled={busy} aria-label={t('routines.unattended.price.remove', { model: id })} onClick={() => save({ [id]: null })}>{t('routines.delete')}</button></li>)}</ul> : null}
    <form onSubmit={event => { event.preventDefault(); if (valid) { save({ [model.trim()]: parsed }); setModel(''); setRates({ input: '', cacheWrite: '', cacheRead: '', output: '' }); } }}>
      <label>{t('routines.unattended.price.model')}<input value={model} maxLength={256} onChange={event => setModel(event.target.value)} /></label>
      {RATE_FIELDS.map(key => <label key={key}>{t(`routines.unattended.price.${key}` as const)}<input type="number" min={0} step="any" inputMode="decimal" value={rates[key]} onChange={event => setRates(current => ({ ...current, [key]: event.target.value }))} /></label>)}
      <button type="submit" className="lab-assistant-action" disabled={busy || !valid}>{t('routines.unattended.price.add')}</button>
    </form>
  </section>;
}

function Basics({ zone, absenceDays, busy, save }: { zone: string; absenceDays: number; busy: boolean; save(change: SetUnattended): void }) {
  const t = useTranslate();
  const [draftZone, setZone] = useState(zone), [days, setDays] = useState(String(absenceDays));
  const zones = useMemo(() => typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [], []);
  const goodZone = zones.length === 0 || zones.includes(draftZone) || draftZone === 'UTC';
  const number = Number.parseInt(days, 10), goodDays = Number.isInteger(number) && number >= 0 && number <= 365;
  const changed = draftZone !== zone || number !== absenceDays;
  return <form className="lab-bot-audit-thresholds" onSubmit={event => { event.preventDefault(); if (goodZone && goodDays) save({ timeZone: draftZone, absenceDays: number }); }}>
    <label>{t('routines.unattended.timeZone')}<input list="lab-time-zones" value={draftZone} aria-invalid={!goodZone} onChange={event => setZone(event.target.value)} /></label>
    <datalist id="lab-time-zones">{zones.map(item => <option key={item} value={item} />)}</datalist>
    <label>{t('routines.unattended.absenceDays')}<input type="number" min={0} max={365} inputMode="numeric" value={days} onChange={event => setDays(event.target.value)} /></label>
    <button type="submit" className="lab-assistant-action" disabled={busy || !changed || !goodZone || !goodDays}>{t('routines.unattended.save')}</button>
  </form>;
}
