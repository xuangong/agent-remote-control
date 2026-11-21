import { describe, expect, it } from 'vitest';
import { composerAvailability, sessionActivityLabel, sessionNotice, sessionNoticeWords, type ComposerBlock, type SessionFacts, type SessionNotice } from './session-presentation.js';
import { leaseNoticeLabel, leaseView } from './lease-view.js';
import { translator } from '../presentation/messages.js';
import { buildSnapshot } from '../testing/builders.js';
import { buildSessionFacts, CONNECTIONS, CONTROL, LIMIT_NOW, LIMIT_RESETS_AT, SESSION_PRESENTATION_VECTORS, T5_PATTERN, type ReplicaFacts } from '../testing/session-presentation-vectors.js';
import { momentWords } from '../presentation/day-line.js';

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

  it('says when a usage limit resets, in business words (R7)', () => {
    const at = (resetsAt: number) => sessionNoticeWords({ kind: 'usage_limited', resetsAt, now: LIMIT_NOW }, translator('en'), 'en');
    expect(at(LIMIT_RESETS_AT)).toMatch(/^This account's usage limit resets today at \d\d:00\. Messages you send wait and go out then\.$/);
    expect(sessionNoticeWords({ kind: 'usage_limited' })).toBe('This account reached its usage limit. Messages go out again once it resets.');
  });

  it('says a pending command while the session is idle, and nothing before the Snapshot', () => {
    expect(sessionActivityLabel(buildSessionFacts('ready', { snapshot: { status: 'idle' }, control: CONTROL.granted }), true)).toBe('Executing command');
    expect(sessionActivityLabel(buildSessionFacts('ready', undefined), true)).toBeUndefined();
  });
});

describe('the words of a session in Chinese', () => {
  const zh = translator('zh');
  const notices: ReadonlyArray<readonly [SessionNotice, string]> = [
    [{ kind: 'host_offline', hostName: 'Mac mini' }, 'Mac mini 离线了，回来后消息会送达～'],
    [{ kind: 'host_offline' }, '这台 Host 离线了，回来后消息会送达～'],
    [{ kind: 'ended' }, '这段会话已结束。'],
    [{ kind: 'failed', message: 'The agent failed without error details.' }, 'Agent 出错了，没有更多信息。'],
    [{ kind: 'failed', message: 'Model quota exhausted.' }, 'Model quota exhausted.'],
    [{ kind: 'terminal_in_control' }, '命令行正在控制'],
    [{ kind: 'other_controller' }, '另一个 Controller 正在控制'],
    [{ kind: 'read_only' }, '随时可以接手'],
    [{ kind: 'unavailable', message: 'This session is unavailable.' }, '这段会话现在用不了。'],
    [{ kind: 'unavailable', message: 'Session was deleted' }, 'Session was deleted'],
    [{ kind: 'agent_unavailable', message: 'The agent is not available on Mac mini.' }, 'Mac mini 上的 Agent 暂时用不了。'],
    [{ kind: 'agent_unavailable', message: 'The agent is not available on its Host.' }, '它所在的 Host 上的 Agent 暂时用不了。'],
    [{ kind: 'usage_limited' }, '这个账号的用量到上限了，额度恢复后才能接着发消息。'],
  ];

  it.each(notices.map(([notice, words]) => [`${notice.kind}: ${words}`, notice, words] as const))('words the notice %s', (_name, notice, words) => {
    expect(sessionNoticeWords(notice, zh)).toBe(words);
  });

  it('says when a usage limit resets (R7)', () => {
    expect(sessionNoticeWords({ kind: 'usage_limited', resetsAt: LIMIT_RESETS_AT, now: LIMIT_NOW }, zh, 'zh')).toMatch(/^这个账号的用量到上限了，今天 \d\d:00 恢复。现在发的消息会先等着，到时候再发出去～$/);
  });

  it('words each lease state', () => {
    expect(leaseNoticeLabel('native_cli', zh)).toBe('命令行正在控制');
    expect(leaseNoticeLabel('other_controller', zh)).toBe('另一个 Controller 正在控制');
    expect(leaseNoticeLabel('read_only', zh)).toBe('随时可以接手');
  });

  it('words the composer block and the activity label', () => {
    expect(composerAvailability(buildSessionFacts('ready', { snapshot: { status: 'idle', capabilities: { ...buildSnapshot().capabilities, sendMessage: false } } }), zh))
      .toEqual({ input: 'disabled', reason: 'unsupported', words: '这个 Agent 不接收消息。' });
    const closed = SESSION_PRESENTATION_VECTORS.find(row => row.name === 'ready, closed')!.facts;
    expect(composerAvailability(closed, zh)).toEqual({ input: 'disabled', reason: 'ended', words: '这段会话已结束。' });
    expect(sessionActivityLabel(closed, false, zh)).toBe('已结束');
    const terminal = SESSION_PRESENTATION_VECTORS.find(row => row.name === 'ready, a terminal has control')!.facts;
    expect(sessionActivityLabel(terminal, false, zh)).toBe('命令行正在控制');
  });
});

describe('the order of the notice and the reasons of the composer', () => {
  it('has a row for every reason that disables the composer', () => {
    const reasons = new Set(SESSION_PRESENTATION_VECTORS.flatMap(row => row.composer.input === 'disabled' ? [row.composer.reason] : []));
    const all: ComposerBlock[] = ['read_only', 'terminal_in_control', 'other_controller', 'cli_refused', 'ended', 'failed', 'unavailable', 'unsupported'];
    expect([...reasons].sort()).toEqual([...all].sort());
  });

  it('disables the composer in every row that has a business fact', () => {
    for (const { name, facts } of SESSION_PRESENTATION_VECTORS) {
      const { session, replica } = facts;
      const business = session.connection === 'unavailable' || session.activity === 'failed' || session.activity === 'closed'
        || leaseView(session.control).readOnly || replica?.agent?.capabilities.sendMessage === false;
      expect(composerAvailability(facts).input === 'disabled', name).toBe(business);
    }
  });
});

describe('the same facts give the same outputs', () => {
  it.each(SESSION_PRESENTATION_VECTORS.map(row => [row.name, row] as const))('%s: a repeat call and an equal copy agree', (_name, row) => {
    const copy: SessionFacts = { ...row.facts, session: { ...row.facts.session }, ...(row.facts.host ? { host: { ...row.facts.host } } : {}) };
    for (const facts of [row.facts, row.facts, copy]) {
      expect(sessionNotice(facts)).toEqual(row.notice);
      expect(composerAvailability(facts)).toEqual(row.composer);
      expect(sessionActivityLabel(facts)).toBe(row.label);
      expect(sessionActivityLabel(facts, true)).toEqual(sessionActivityLabel(row.facts, true));
    }
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

  it('sends now exactly when synchronized, the control check is over and send_message is allowed, and no usage limit holds sends until a known reset (R7)', () => {
    for (const { name, facts } of rows) {
      const composer = composerAvailability(facts);
      if (composer.input === 'disabled') continue;
      const { session } = facts;
      const notice = sessionNotice(facts);
      const held = notice?.kind === 'usage_limited' && notice.resetsAt !== undefined;
      expect(composer.dispatch, name).toBe(session.synchronized && !session.controlChecking && session.operations.send_message.allowed && !held ? 'now' : 'when_ready');
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

describe('a moment as a sentence says it', () => {
  const now = Date.parse('2026-11-22T10:00:00Z');
  it.each([
    ['en', '2026-11-22T15:05:00Z', 'today at 15:05'],
    ['en', '2026-11-23T09:00:00Z', 'tomorrow at 09:00'],
    ['en', '2026-11-28T09:00:00Z', 'Nov 28 at 09:00'],
    ['en', '2027-01-03T09:00:00Z', 'Jan 3, 2027 at 09:00'],
    ['zh', '2026-11-22T15:05:00Z', '今天 15:05'],
    ['zh', '2026-11-23T09:00:00Z', '明天 09:00'],
    ['zh', '2026-11-28T09:00:00Z', '11月28日 09:00'],
  ] as const)('in %s, %s is "%s"', (locale, time, words) => {
    expect(momentWords(Date.parse(time), now, locale, translator(locale), 'UTC')).toBe(words);
  });
});
