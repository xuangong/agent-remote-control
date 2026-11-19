import { describe, expect, it } from 'vitest';
import { composerAvailability, sessionActivityLabel, sessionNotice, sessionNoticeWords, type SessionFacts } from './session-presentation.js';
import { leaseView } from './lease-view.js';
import { buildSessionFacts, CONNECTIONS, CONTROL, SESSION_PRESENTATION_VECTORS, T5_PATTERN, type ReplicaFacts } from '../testing/session-presentation-vectors.js';

const BUSINESS_LABELS = new Set(['Ready', 'Working', 'Waiting for response', 'Starting', 'Closed', 'Agent failed', 'Executing command', 'Native CLI has control', 'Native control transferred']);

describe('the presentation of a session, row by row', () => {
  it.each(SESSION_PRESENTATION_VECTORS.map(row => [row.name, row] as const))('%s', (_name, row) => {
    expect(sessionNotice(row.facts)).toEqual(row.notice);
    expect(composerAvailability(row.facts)).toEqual(row.composer);
    expect(sessionActivityLabel(row.facts)).toBe(row.label);
  });

  it('words a notice in business terms', () => {
    expect(sessionNoticeWords({ kind: 'host_offline', hostName: 'Mac mini' })).toBe('Mac mini is offline. Messages will be delivered when it is back.');
    expect(sessionNoticeWords({ kind: 'host_offline' })).toBe('The Host is offline. Messages will be delivered when it is back.');
    expect(sessionNoticeWords({ kind: 'ended' })).toBe('This session has ended.');
    expect(sessionNoticeWords({ kind: 'terminal_in_control' })).toBe('Native CLI has control');
  });

  it('says a pending command while the session is idle, and nothing before the Snapshot', () => {
    expect(sessionActivityLabel(buildSessionFacts('ready', { snapshot: { status: 'idle' }, control: CONTROL.granted }), true)).toBe('Executing command');
    expect(sessionActivityLabel(buildSessionFacts('ready', undefined), true)).toBeUndefined();
  });
});

// Every combination of the facts that are not business facts, crossed with the business facts that may coexist with them.
const LEASES = { none: undefined, checking: CONTROL.checking, granted: CONTROL.granted, readOnly: CONTROL.readOnly } as const;
const RUNTIMES = ['connected', 'reconnecting', 'restoring'] as const;
const ACTIVITIES = ['none', 'idle', 'running', 'waiting', 'starting'] as const;
const HOSTS = { unknown: undefined, online: { online: true, name: 'Mac mini' }, offline: { online: false, name: 'Mac mini' } } as const;

const STALE = { message: 'Protocol version is incompatible.', recoverable: false };
function replicaFacts(activity: typeof ACTIVITIES[number], runtime: typeof RUNTIMES[number], control: ReplicaFacts['control'], restored: boolean): ReplicaFacts | undefined {
  // Every replica carries a non-recoverable diagnostic from an earlier attempt: it must never speak for a later one.
  if (activity === 'none') return control ? { control, diagnostic: STALE } : undefined;
  const runtimeInfo = { providerId: 'codex', sessionId: 'native-1', status: activity, ...(runtime === 'connected' ? {} : { connection: { state: runtime } }) };
  const activeTurn = activity === 'running' || activity === 'waiting' ? { turnId: 't1' } : null;
  return { snapshot: { status: activity, activeTurn, runtimeInfo }, control, restored, diagnostic: STALE };
}

const combinations: Array<{ name: string; facts: SessionFacts; business: boolean }> = [];
for (const connection of CONNECTIONS) for (const [leaseName, control] of Object.entries(LEASES)) for (const runtime of RUNTIMES)
  for (const activity of ACTIVITIES) for (const [hostName, host] of Object.entries(HOSTS)) for (const restored of [false, true]) {
    if (activity === 'none' && (runtime !== 'connected' || restored)) continue;
    combinations.push({
      name: `${connection}/${leaseName}/${runtime}/${activity}/${hostName}${restored ? '/restored' : ''}`,
      facts: buildSessionFacts(connection, replicaFacts(activity, runtime, control, restored), host),
      business: connection === 'unavailable' || leaseName === 'readOnly' || hostName === 'offline',
    });
  }

describe('R1: connection phase, control check, synchronization, held rows and a recovering runtime say nothing', () => {
  it(`gives no T5 word in any output, over ${combinations.length} combinations`, () => {
    for (const { name, facts } of combinations) {
      const notice = sessionNotice(facts);
      const composer = composerAvailability(facts);
      const outputs = [notice ? sessionNoticeWords(notice) : '', composer.input === 'disabled' ? composer.words : '', sessionActivityLabel(facts) ?? '', sessionActivityLabel(facts, true) ?? ''];
      expect(outputs.filter(text => T5_PATTERN.test(text)), name).toEqual([]);
    }
  });

  it('gives no notice, an enabled composer and a business label or none when no business fact is present', () => {
    for (const { name, facts } of combinations.filter(combination => !combination.business)) {
      expect(sessionNotice(facts), name).toBeUndefined();
      expect(composerAvailability(facts).input, name).toBe('enabled');
      const label = sessionActivityLabel(facts);
      expect(label === undefined || BUSINESS_LABELS.has(label), `${name}: ${label}`).toBe(true);
    }
  });
});

describe('R2 and R3: the composer', () => {
  const rows = [...combinations.map(({ name, facts }) => ({ name, facts })), ...SESSION_PRESENTATION_VECTORS];

  it('is disabled only with a business fact present', () => {
    for (const { name, facts } of rows) {
      const composer = composerAvailability(facts);
      if (composer.input === 'enabled') continue;
      const { session, replica } = facts;
      const business = session.connection === 'unavailable' || session.activity === 'failed' || session.activity === 'closed'
        || leaseView(session.control).readOnly || replica?.agent?.capabilities.sendMessage === false;
      expect(business, `${name}: ${composer.reason}`).toBe(true);
      expect(composer.words, name).not.toBe('');
    }
  });

  it('sends now exactly when synchronized, the control check is over and send_message is allowed', () => {
    for (const { name, facts } of rows) {
      const composer = composerAvailability(facts);
      if (composer.input === 'disabled') continue;
      const { session } = facts;
      expect(composer.dispatch, name).toBe(session.synchronized && !session.controlChecking && session.operations.send_message.allowed ? 'now' : 'when_ready');
    }
  });

  it('keeps an offline Host enabled (R4)', () => {
    const offline = combinations.filter(({ name }) => name.includes('/offline') && !name.startsWith('unavailable/') && !name.includes('/readOnly/'));
    expect(offline.length).toBeGreaterThan(0);
    for (const { name, facts } of offline) {
      expect(sessionNotice(facts)?.kind, name).toBe('host_offline');
      expect(composerAvailability(facts).input, name).toBe('enabled');
    }
  });
});
