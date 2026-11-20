import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayLineLabel, startsDayLine } from './day-line.js';
import { translator } from './messages.js';

const now = Date.parse('2026-11-20T18:57:00Z');

describe('day lines', () => {
  it.each([
    ['the first turn', undefined, '2026-11-20T10:00:00Z', true],
    ['a turn soon after the last', '2026-11-20T10:00:00Z', '2026-11-20T10:29:59Z', false],
    ['half an hour later', '2026-11-20T10:00:00Z', '2026-11-20T10:30:00Z', true],
    ['the next day, minutes later', '2026-11-20T23:58:00Z', '2026-11-21T00:01:00Z', true],
    ['an unreadable time', '2026-11-20T10:00:00Z', 'soon', false],
  ] as const)('%s', (_name, previous, current, expected) => {
    expect(startsDayLine(previous, current, 'UTC')).toBe(expected);
  });

  it('names today and yesterday, and dates other days, in each locale', () => {
    const en = translator('en'), zh = translator('zh');
    expect(dayLineLabel('2026-11-20T18:57:00Z', now, 'en', en, 'UTC')).toBe('Today 18:57');
    expect(dayLineLabel('2026-11-20T18:57:00Z', now, 'zh', zh, 'UTC')).toBe('今天 18:57');
    expect(dayLineLabel('2026-11-19T09:02:00Z', now, 'en', en, 'UTC')).toBe('Yesterday 09:02');
    expect(dayLineLabel('2026-11-12T09:02:00Z', now, 'en', en, 'UTC')).toBe('Nov 12 09:02');
    expect(dayLineLabel('2025-11-12T09:02:00Z', now, 'en', en, 'UTC')).toBe('Nov 12, 2025 09:02');
  });

  afterEach(() => { vi.restoreAllMocks(); });

  // A long conversation asks for its day lines on every render; making a formatter costs far more than using one.
  it('makes no new date formatter when the same lines are asked for again', () => {
    const en = translator('en');
    const lines = () => Array.from({ length: 50 }, (_, index) => {
      const start = new Date(now - index * 60_000).toISOString();
      return startsDayLine(new Date(now - index * 60_000 - 30_000).toISOString(), start) ? dayLineLabel(start, now, 'en', en) : '';
    });
    const first = lines();
    const made = vi.spyOn(Intl, 'DateTimeFormat');
    expect(lines()).toEqual(first);
    expect(made).not.toHaveBeenCalled();
  });
});
