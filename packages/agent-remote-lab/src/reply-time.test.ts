import { expect, it } from 'vitest';
import { replyTime } from './reply-time.js';

const at = (value: string) => new Date(value).getTime();

it('shows a reply time the way chat lists do', () => {
  const now = at('2026-11-14T15:30:00');
  expect(replyTime(at('2026-11-14T10:42:00'), now, 'en-US')).toBe('10:42 AM');
  expect(replyTime(at('2026-11-13T23:59:00'), now, 'en-US')).toBe('Yesterday');
  expect(replyTime(at('2026-11-10T08:00:00'), now, 'en-US')).toBe('Tue');
  expect(replyTime(at('2026-11-08T08:00:00'), now, 'en-US')).toBe('Sun');
  expect(replyTime(at('2026-11-07T08:00:00'), now, 'en-US')).toBe('11/7/26');
  // A clock slightly ahead on the Host still reads as today.
  expect(replyTime(at('2026-11-14T15:31:00'), now, 'en-US')).toBe('3:31 PM');
});
