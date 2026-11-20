import { useEffect, useState, type ComponentProps } from 'react';
import type { OutboxEntry } from '@orchardworks/agent-remote-protocol';
import { errorWords, translator, type SessionStateRef, type Translate } from '@orchardworks/agent-client';
import { useSharedFeed } from '../shared-feeds.js';
import { UserMessageItem, useTranslate } from '@orchardworks/agent-client-web/react';
import './outbox-messages.css';

/** How long a message has waited, once that is over a minute: 5 min, 2 h, 3 d. */
export function waitingAge(createdAt: number, now: number, t: Translate = translator('en')): string {
  const minutes = Math.floor((now - createdAt) / 60_000);
  if (minutes < 1) return '';
  if (minutes < 60) return t('sessions.outbox.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? t('sessions.outbox.hours', { count: hours }) : t('sessions.outbox.days', { count: Math.floor(hours / 24) });
}

function useNow(enabled: boolean, fixed?: number): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined || !enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [enabled, fixed]);
  return fixed ?? now;
}

const icon = { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true } as const;

/**
 * Messages that wait in the outbox for this conversation's Host, after its last entry on every device. Each is an
 * outgoing bubble that is not part of the conversation yet: it says what it waits for (and, once over a minute, for how
 * long) and can be taken back until the Host delivers it; one that was not delivered says why and can be sent again.
 */
export function OutboxMessages({ entries, hostName, hostOnline, now: fixedNow, onCancel, onRetry }: {
  entries: readonly OutboxEntry[]; hostName: string; hostOnline: boolean;
  /** The time to measure waits from; the clock by default. */
  now?: number;
  onCancel(id: string): Promise<void>; onRetry(id: string): Promise<void>;
}) {
  const now = useNow(entries.length > 0, fixedNow);
  if (!entries.length) return null;
  return <>{entries.map(entry => <OutboxMessage key={entry.id} entry={entry} hostName={hostName} hostOnline={hostOnline} now={now} onCancel={onCancel} onRetry={onRetry} />)}</>;
}

/**
 * A conversation's messages in the account's outbox, read from the page's shared feeds: an outbox frame renders these
 * bubbles, not the conversation around them.
 */
export function SessionOutboxMessages({ session, ...props }: Omit<ComponentProps<typeof OutboxMessages>, 'entries'> & { session: SessionStateRef }) {
  const outbox = useSharedFeed(snapshot => snapshot.outbox);
  const entries = outbox?.entries(session) ?? [];
  return entries.length ? <OutboxMessages entries={entries} {...props} /> : null;
}

function OutboxMessage({ entry, hostName, hostOnline, now, onCancel, onRetry }: { entry: OutboxEntry; hostName: string; hostOnline: boolean; now: number;
  onCancel(id: string): Promise<void>; onRetry(id: string): Promise<void> }) {
  const t = useTranslate();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const settled = entry.status === 'failed' || entry.status === 'unknown';
  const age = waitingAge(entry.createdAt, now, t);
  const waiting = hostOnline ? t('sessions.outbox.waitingToSend') : t('sessions.outbox.waitingForHost', { host: hostName });
  const label = entry.status === 'delivering' ? t('sessions.outbox.sending') : entry.status === 'failed' ? t('sessions.outbox.notDelivered') : entry.status === 'unknown' ? t('sessions.outbox.checkDelivery')
    : age ? t('sessions.outbox.withAge', { label: waiting, age }) : waiting;
  async function act(action: (id: string) => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await action(entry.id); }
    catch (reason) { setError(errorWords(reason, t, 'sessions.outbox.failed')); }
    finally { setBusy(false); }
  }
  return <div className="agent-timeline-entry agent-outgoing-message lab-outbox-message" data-entry-key={`outbox:${entry.id}`}
    data-delivery-state={entry.status === 'waiting' ? 'waiting' : entry.status === 'delivering' ? 'pending' : entry.status === 'failed' ? 'failed' : 'unconfirmed'}
    aria-busy={entry.status === 'delivering' || undefined}>
    <UserMessageItem item={{ type: 'user_message', text: entry.text }} />
    <div className="agent-message-delivery" role={settled ? 'alert' : 'status'}>
      {settled ? <svg {...icon} className="lab-outbox-icon"><circle cx="10" cy="10" r="8" /><path d="M10 5v6m0 3v1" /></svg>
        : <svg {...icon} className="lab-outbox-icon"><circle cx="10" cy="10" r="7.5" /><path d="M10 6v4.5l3 2" /></svg>}
      <span className="lab-outbox-label">{label}</span>
      {entry.status !== 'delivering' ? <span className="agent-delivery-actions">
        {settled ? <button type="button" aria-label={t('sessions.outbox.sendAgain')} title={t('sessions.outbox.sendAgain')} disabled={busy} onClick={() => void act(onRetry)}><svg {...icon}><path d="M3 8a7 7 0 1 1 1 7M3 3v5h5" /></svg></button> : null}
        <button type="button" aria-label={entry.status === 'waiting' ? t('sessions.outbox.cancelMessage') : t('sessions.outbox.dismissMessage')} title={entry.status === 'waiting' ? t('sessions.outbox.cancelTitle') : t('sessions.outbox.dismissTitle')}
          disabled={busy} onClick={() => void act(onCancel)}><svg {...icon}><path d="m5.5 5.5 9 9m0-9-9 9" /></svg></button>
      </span> : null}
      {settled && entry.error ? <span className="agent-delivery-error">{entry.error}</span> : null}
      {error ? <span className="agent-delivery-error" role="alert">{error}</span> : null}
    </div>
  </div>;
}
