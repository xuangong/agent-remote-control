import { describe, expect, it } from 'vitest';

import { agentIdOfSocket, answeredBy, controllerJournalEvents, holeCheck, mixThresholds, percentile, stats, windowCounts } from '../performance/journal-measurement.mjs';

const at = (ms: number) => new Date(ms).toISOString();
const diagnostic = (ms: number, event: string, fields: Record<string, unknown> = {}) => ({ timestamp: at(ms), event, ...fields });

describe('the statistics', () => {
  it('takes percentiles of the finite values and nothing of an empty list', () => {
    expect(percentile([10, 20, 30, 40, 50], 0.5)).toBe(30);
    expect(percentile([1, Number.NaN, 3], 1)).toBe(3);
    expect(stats([])).toEqual({ n: 0, p50: null, p95: null, max: null });
    expect(stats([5, 1, 3])).toMatchObject({ n: 3, p50: 3, max: 5 });
  });
});

describe('what the Relay\'s diagnostics say about an open', () => {
  const log = [
    diagnostic(1000, 'journal_window', { agentId: 'copilot:a', reason: 'unchanged', bytes: 500 }),
    diagnostic(1500, 'journal_window', { agentId: 'copilot:a', reason: 'open_item', bytes: 900 }),
    diagnostic(1600, 'journal_window', { agentId: 'copilot:b', reason: 'changed', bytes: 100 }),
    diagnostic(1700, 'journal_request', { agentId: 'copilot:a', reason: 'fill' }),
    diagnostic(1800, 'journal_request', { agentId: 'copilot:a', reason: 'older' }),
    diagnostic(1900, 'journal_quota_exceeded', {}),
    diagnostic(9000, 'journal_window', { agentId: 'copilot:a', reason: 'new', bytes: 1 }),
  ];

  it('counts the windows by reason, their bytes and the requests of one session between two moments', () => {
    expect(windowCounts(log, { fromMs: 900, toMs: 2000, agentId: 'copilot:a' })).toEqual({
      windows: 2, byReason: { unchanged: 1, open_item: 1 }, bytes: [500, 900], requests: { fill: 1, older: 1 }, quotaRefusals: 1,
    });
    expect(windowCounts(log).windows).toBe(4);
  });

  it('says the Controller answered an open when the Relay opened a Controller stream for the session during it, and the journal otherwise', () => {
    const streams = [diagnostic(1200, 'stream_opening', { agentId: 'agent-1' }), diagnostic(5000, 'stream_opening', { agentId: 'agent-2' })];
    expect(answeredBy(streams, { agentId: 'agent-1', fromMs: 1000, toMs: 2000 })).toBe('controller');
    expect(answeredBy(streams, { agentId: 'agent-1', fromMs: 2000, toMs: 3000 })).toBe('journal');
    expect(answeredBy(streams, { agentId: 'agent-3', fromMs: 0, toMs: 9000 })).toBe('journal');
  });

  it('reads the session\'s public agent id from the socket the page opened', () => {
    expect(agentIdOfSocket('wss://relay.test/u/alice/v1/sessions/agent-7/events')).toBe('agent-7');
    expect(agentIdOfSocket('wss://relay.test/other')).toBeUndefined();
  });

  it('counts the Controller\'s refusals and stops of journals', () => {
    const entries = [{ time: at(1000), event: 'journal_open_refused' }, { time: at(1100), event: 'journal_session_stopped' }, { time: at(1200), event: 'something_else' }, { time: at(9000), event: 'journal_open_refused' }];
    expect(controllerJournalEvents(entries, { fromMs: 0, toMs: 2000 })).toEqual({ journal_open_refused: 1, journal_session_stopped: 1, journal_session_unserved: 0, journal_session_restarted: 0 });
  });
});

describe('the hole check', () => {
  const native = [
    { id: '1', role: 'user', text: 'Fix the bug' }, { id: '2', role: 'tool', text: '{"name":"bash"}' },
    { id: '3', role: 'assistant', text: 'The cause is   a race.' },
  ];

  it('finds no hole when every user and assistant message of the native read is shown, whatever the whitespace', () => {
    expect(holeCheck(native, ['Fix the bug', 'The cause is a race.'])).toEqual({ nativeMessages: 2, servedMessages: 2, missing: [] });
  });

  it('names a message the journal-served read does not show', () => {
    expect(holeCheck(native, ['Fix the bug']).missing).toEqual([{ id: '3', role: 'assistant', preview: 'The cause is a race.' }]);
  });
});

describe('the thresholds of the S3 plan', () => {
  const step = (kind: string, byReason: Record<string, number>, extra: { fills?: number; quota?: number; missing?: number } = {}) => ({
    kind, windows: { windows: 1, byReason, bytes: [], requests: { fill: extra.fills ?? 0, older: 0 }, quotaRefusals: extra.quota ?? 0 },
    holes: { nativeMessages: 3, servedMessages: 3, missing: Array.from({ length: extra.missing ?? 0 }, () => ({ id: 'x', role: 'user', preview: '' })) },
  });
  const settledMix = () => [...Array(10).fill(0).map(() => step('reload', { unchanged: 1 })), ...Array(10).fill(0).map(() => step('release', { unchanged: 1 })), ...Array(5).fill(0).map(() => step('restart', { unchanged: 1 })), ...Array(5).fill(0).map(() => step('interruption', { unchanged: 1 }))];

  it('triggers nothing for a mix that settles', () => {
    expect(mixThresholds(settledMix())).toMatchObject({ opens: 30, openItemReplacements: 0, i2Triggered: false, m3Triggered: false, evictionTriggered: false, changedReplacements: 0 });
  });

  it('triggers I2 for more than five percent of open_item replacements, or any on a settled reopen', () => {
    const interrupted = settledMix().map((value, index) => index >= 25 && index < 27 ? step('interruption', { open_item: 1 }) : value);
    expect(mixThresholds(interrupted)).toMatchObject({ openItemReplacements: 2, i2Triggered: true });
    const released = settledMix().map((value, index) => index === 12 ? step('release', { open_item: 1 }) : value);
    expect(mixThresholds(released).i2Triggered).toBe(true);
  });

  it('triggers M3 when more than one interruption leaves a hole, and eviction on fills or a refusal', () => {
    const holes = settledMix().map((value, index) => index >= 25 && index < 27 ? step('interruption', { unchanged: 1 }, { missing: 1 }) : value);
    expect(mixThresholds(holes)).toMatchObject({ interruptionsWithHoles: 2, m3Triggered: true });
    expect(mixThresholds(settledMix().map(() => step('reload', { unchanged: 1 }, { fills: 2 }))).evictionTriggered).toBe(true);
    expect(mixThresholds(settledMix().map((value, index) => index === 3 ? step('reload', { new: 1 }, { quota: 1 }) : value)).evictionTriggered).toBe(true);
  });
});
