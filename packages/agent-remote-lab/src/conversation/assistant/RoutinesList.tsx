import { useContext, useState, type FormEvent } from 'react';
import { ROUTINE_PROMPT_LIMIT, ROUTINE_MAX_EVERY_MINUTES, ROUTINE_MIN_EVERY_MINUTES, ROUTINE_MAX_QUIET_MINUTES, localTime, zonedInstant, type Routine, type RoutineSchedule } from '@orchardworks/agent-remote-protocol';
import { costWords, nextRunWords, runWords, scheduleWords, weekdayName } from '@orchardworks/agent-client';
import { LocaleContext, useTranslate } from '@orchardworks/agent-client-web/react';

/** What the person saves of a routine: the fields `routine_set` takes. */
export interface RoutineSpec { name: string; schedule: RoutineSchedule; prompt?: string; model?: string; maxRunsPerDay?: number; untilMinutes?: number }
/** A bot's routines as its details show and change them (routines design 10). */
export interface RoutinesChoice {
  readonly routines: readonly Routine[];
  /** The person's time zone, where times are read and shown. */
  readonly zone: string;
  /** Why no unattended start happens now (paused, budget, provider limit, absence), for the next-run line. */
  readonly hold?: string;
  save(spec: RoutineSpec): Promise<void>;
  pause(name: string, paused: boolean): Promise<void>;
  remove(name: string): Promise<void>;
  test(name: string): Promise<void>;
}
const KINDS = ['every', 'daily', 'weekdays', 'once', 'quiet'] as const;
type Kind = typeof KINDS[number];
const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const pad = (value: number) => String(value).padStart(2, '0');

/** The form's state, read back from a routine so editing starts where it was. */
function draftOf(routine: Routine | undefined, zone: string) {
  const schedule = routine?.schedule, local = schedule?.kind === 'once' ? localTime(schedule.at, zone) : undefined;
  return { name: routine?.name ?? '', kind: (schedule && schedule.kind !== 'event' ? schedule.kind : 'every') as Kind,
    minutes: schedule && (schedule.kind === 'every' || schedule.kind === 'quiet') ? String(schedule.minutes) : '60',
    time: schedule && (schedule.kind === 'daily' || schedule.kind === 'weekdays') ? schedule.time : '09:00',
    days: schedule?.kind === 'weekdays' ? [...schedule.days] : [1, 2, 3, 4, 5],
    at: local ? `${local.year}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}` : '',
    prompt: routine?.prompt ?? '', model: routine?.model ?? '', maxRuns: routine?.maxRunsPerDay === undefined ? '' : String(routine.maxRunsPerDay) };
}
type Draft = ReturnType<typeof draftOf>;
/** The routine the form describes, or undefined while it is not complete. */
export function specOf(draft: Draft, zone: string): RoutineSpec | undefined {
  const name = draft.name.trim(), minutes = Number.parseInt(draft.minutes, 10);
  let schedule: RoutineSchedule | undefined;
  if (draft.kind === 'every' && minutes >= ROUTINE_MIN_EVERY_MINUTES && minutes <= ROUTINE_MAX_EVERY_MINUTES) schedule = { kind: 'every', minutes };
  else if (draft.kind === 'quiet' && minutes >= 1 && minutes <= ROUTINE_MAX_QUIET_MINUTES) schedule = { kind: 'quiet', minutes };
  else if (draft.kind === 'daily' && draft.time) schedule = { kind: 'daily', time: draft.time };
  else if (draft.kind === 'weekdays' && draft.time && draft.days.length) schedule = { kind: 'weekdays', days: [...draft.days].sort((a, b) => a - b), time: draft.time };
  else if (draft.kind === 'once' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(draft.at)) {
    const [date, clock] = draft.at.split('T') as [string, string], [year, month, day] = date.split('-').map(Number) as [number, number, number], [hour, minute] = clock.split(':').map(Number) as [number, number];
    schedule = { kind: 'once', at: zonedInstant(year, month, day, hour, minute, zone) };
  }
  if (!name || !schedule) return undefined;
  const maxRuns = Number.parseInt(draft.maxRuns, 10), prompt = draft.prompt.trim(), model = draft.model.trim();
  return { name, schedule, ...(prompt ? { prompt } : {}), ...(model ? { model } : {}), ...(maxRuns >= 1 ? { maxRunsPerDay: maxRuns } : {}) };
}

export function RoutinesList({ choice }: { choice: RoutinesChoice }) {
  const t = useTranslate(), locale = useContext(LocaleContext);
  const [editing, setEditing] = useState<{ name?: string } | undefined>(), [open, setOpen] = useState<string>(), [failed, setFailed] = useState<string>(), [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>, message = 'routines.failed' as const) => {
    if (busy) return;
    setBusy(true); setFailed(undefined);
    try { await action(); } catch { setFailed(t(message)); } finally { setBusy(false); }
  };
  const now = Date.now();
  return <div className="lab-assistant-process lab-routines">
    {choice.routines.length ? <ul className="lab-assistant-memory lab-routines-list">{choice.routines.map(routine => {
      const last = routine.runs.at(-1), average = routine.runs.filter(item => item.usd !== undefined).slice(-5), cost = average.length ? average.reduce((sum, item) => sum + item.usd!, 0) / average.length : undefined;
      return <li key={routine.id} data-routine={routine.name} data-paused={routine.paused ? '' : undefined}>
        {editing?.name === routine.name ? <RoutineForm routine={routine} zone={choice.zone} busy={busy} cancel={() => setEditing(undefined)} save={spec => run(async () => { await choice.save(spec); setEditing(undefined); })} /> : <>
          <span className="lab-assistant-session-title">{routine.name}</span>
          <small>{scheduleWords(routine.schedule, choice.zone, locale, t)} · {nextRunWords(routine, now, choice.zone, locale, t, choice.hold)}</small>
          <small>{[t(`routines.by.${routine.by}` as const), ...(routine.model ? [t('routines.model.is', { model: routine.model })] : []), ...(cost !== undefined ? [t('routines.cost.each', { cost: costWords(cost, locale) })] : [])].join(' · ')}</small>
          {last ? <small>{runWords(last, choice.zone, locale, t)}</small> : null}
          <span className="lab-assistant-task-actions">
            <button type="button" className="lab-assistant-action" disabled={busy} onClick={() => void run(() => choice.test(routine.name), 'routines.test.failed' as never)}>{t('routines.test')}</button>
            <button type="button" className="lab-assistant-action" disabled={busy} aria-pressed={!!routine.paused} onClick={() => void run(() => choice.pause(routine.name, !routine.paused))}>{t(routine.paused ? 'routines.resume' : 'routines.pause')}</button>
            <button type="button" className="lab-assistant-action" aria-expanded={open === routine.name} onClick={() => setOpen(open === routine.name ? undefined : routine.name)}>{t('routines.history')}</button>
            {routine.work ? null : <button type="button" className="lab-assistant-action" onClick={() => setEditing({ name: routine.name })}>{t('routines.edit')}</button>}
            {routine.work ? null : <button type="button" className="lab-assistant-action" disabled={busy} onClick={() => void run(() => choice.remove(routine.name))}>{t('routines.delete')}</button>}
          </span>
          {open === routine.name ? (routine.runs.length ? <ol className="lab-routines-history" aria-label={t('routines.history')}>{[...routine.runs].reverse().map(item => <li key={item.n}>{runWords(item, choice.zone, locale, t)}{item.flags?.length ? <small> · {item.flags.join(', ')}</small> : null}</li>)}</ol>
            : <p className="lab-assistant-empty">{t('routines.historyEmpty')}</p>) : null}
        </>}
      </li>;
    })}</ul> : editing ? null : <p className="lab-assistant-empty">{t('routines.empty')}</p>}
    {editing && editing.name === undefined ? <RoutineForm zone={choice.zone} busy={busy} cancel={() => setEditing(undefined)} save={spec => run(async () => { await choice.save(spec); setEditing(undefined); })} /> :
      editing ? null : <button type="button" className="lab-assistant-action" onClick={() => setEditing({})}>{t('routines.new')}</button>}
    {failed ? <p role="alert">{failed}</p> : null}
    <p className="lab-assistant-hint">{t('routines.hint')}</p>
  </div>;
}

function RoutineForm({ routine, zone, busy, save, cancel }: { routine?: Routine; zone: string; busy: boolean; save(spec: RoutineSpec): void; cancel(): void }) {
  const t = useTranslate(), locale = useContext(LocaleContext);
  const [draft, setDraft] = useState(() => draftOf(routine, zone));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const spec = specOf(draft, zone);
  const submit = (event: FormEvent) => { event.preventDefault(); if (spec) save({ ...spec, ...(routine?.endsAt !== undefined ? { untilMinutes: Math.max(1, Math.round((routine.endsAt - Date.now()) / 60_000)) } : {}) }); };
  return <form className="lab-routine-form" onSubmit={submit} aria-label={t(routine ? 'routines.edit' : 'routines.new')}>
    <label>{t('routines.name')}<input value={draft.name} maxLength={60} disabled={!!routine} onChange={event => set('name', event.target.value)} /></label>
    <label>{t('routines.when')}<select value={draft.kind} onChange={event => set('kind', event.target.value as Kind)}>{KINDS.map(kind => <option key={kind} value={kind}>{t(`routines.kind.${kind}` as const)}</option>)}</select></label>
    {draft.kind === 'every' || draft.kind === 'quiet' ? <label>{t('routines.minutes')}<input type="number" inputMode="numeric" min={draft.kind === 'every' ? ROUTINE_MIN_EVERY_MINUTES : 1} value={draft.minutes} onChange={event => set('minutes', event.target.value)} /></label> : null}
    {draft.kind === 'daily' || draft.kind === 'weekdays' ? <label>{t('routines.time')}<input type="time" value={draft.time} onChange={event => set('time', event.target.value)} /></label> : null}
    {draft.kind === 'weekdays' ? <fieldset className="lab-routine-days"><legend>{t('routines.days')}</legend>{DAYS.map(day => <button key={day} type="button" className="lab-assistant-action" aria-pressed={draft.days.includes(day)}
      onClick={() => set('days', draft.days.includes(day) ? draft.days.filter(item => item !== day) : [...draft.days, day])}>{weekdayName(day, locale)}</button>)}</fieldset> : null}
    {draft.kind === 'once' ? <label>{t('routines.at')}<input type="datetime-local" value={draft.at} onChange={event => set('at', event.target.value)} /></label> : null}
    <label>{t('routines.prompt')}<textarea rows={3} maxLength={ROUTINE_PROMPT_LIMIT} value={draft.prompt} onChange={event => set('prompt', event.target.value)} /></label>
    <label>{t('routines.model')}<input value={draft.model} maxLength={256} onChange={event => set('model', event.target.value)} /></label>
    <label>{t('routines.maxRuns')}<input type="number" inputMode="numeric" min={1} max={200} value={draft.maxRuns} onChange={event => set('maxRuns', event.target.value)} /></label>
    <span className="lab-assistant-task-actions">
      <button type="submit" className="lab-assistant-action" disabled={busy || !spec}>{t('routines.save')}</button>
      <button type="button" className="lab-assistant-action" onClick={cancel}>{t('routines.cancel')}</button>
    </span>
  </form>;
}
