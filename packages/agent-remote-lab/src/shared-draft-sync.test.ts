import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSharedDraftSync, draftHash, type SharedDraftAgreement } from './shared-draft-sync.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function composer(initial = '', agreement?: SharedDraftAgreement, publishAs?: (text: string) => Promise<number>) {
  let text = initial, revision = 100;
  const published: string[] = [], remembered: SharedDraftAgreement[] = [];
  const sync = createSharedDraftSync({
    read: () => text,
    apply: value => { text = value; sync.local(value); },
    publish: publishAs ?? (async value => { published.push(value); return ++revision; }),
    agreement, remember: value => { remembered.push(value); },
  });
  return { sync, published, remembered, text: () => text, type: (value: string) => { text = value; sync.local(value); } };
}

it('takes the shared draft into an empty composer', () => {
  const page = composer();
  page.sync.remote({ text: 'Written on the phone', revision: 5 });
  expect(page.text()).toBe('Written on the phone');
  expect(page.remembered.at(-1)).toEqual({ revision: 5, hash: draftHash('Written on the phone') });
  expect(page.published).toEqual([]);
});

it('publishes an edit 800 ms after the last keystroke and agrees on its revision', async () => {
  const page = composer();
  page.sync.remote(undefined);
  page.type('Ship');
  await vi.advanceTimersByTimeAsync(500);
  page.type('Ship it');
  await vi.advanceTimersByTimeAsync(799);
  expect(page.published).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(page.published).toEqual(['Ship it']);
  expect(page.remembered.at(-1)).toEqual({ revision: 101, hash: draftHash('Ship it') });
  // The Relay's echo of the same revision changes nothing.
  page.sync.remote({ text: 'Ship it', revision: 101 });
  expect(page.text()).toBe('Ship it');
});

it('follows a newer shared draft only while it has no unpublished edits', async () => {
  const page = composer();
  page.sync.remote({ text: 'First', revision: 5 });
  page.sync.remote({ text: 'Second', revision: 6 });
  expect(page.text()).toBe('Second');
  // Typing here is never overwritten, and its publish wins.
  page.type('Second, edited here');
  page.sync.remote({ text: 'Third', revision: 7 });
  expect(page.text()).toBe('Second, edited here');
  await vi.advanceTimersByTimeAsync(800);
  expect(page.published).toEqual(['Second, edited here']);
});

it('clears an unchanged composer when the draft was sent elsewhere, and publishes its own send', async () => {
  const page = composer();
  page.sync.remote({ text: 'Ship it', revision: 5 });
  page.sync.remote({ text: '', revision: 6 });
  expect(page.text()).toBe('');
  page.type('Next message');
  await vi.advanceTimersByTimeAsync(800);
  // Sending empties the composer; that clears the draft for every device.
  page.type('');
  await vi.advanceTimersByTimeAsync(800);
  expect(page.published).toEqual(['Next message', '']);
});

it('after a reload, follows the shared draft when its text is what it last agreed on, and keeps an edit made here', async () => {
  const unchanged = composer('Ship it', { revision: 5, hash: draftHash('Ship it') });
  unchanged.sync.remote({ text: '', revision: 6 });
  expect(unchanged.text()).toBe('');
  const edited = composer('Ship it today', { revision: 5, hash: draftHash('Ship it') });
  edited.sync.remote({ text: '', revision: 6 });
  expect(edited.text()).toBe('Ship it today');
  await vi.advanceTimersByTimeAsync(800);
  expect(edited.published).toEqual(['Ship it today']);
});

it('publishes a draft the Relay does not have, and keeps one that diverged without knowing which is newer', async () => {
  const unknown = composer('Typed before drafts were shared');
  unknown.sync.remote(undefined);
  await vi.advanceTimersByTimeAsync(800);
  expect(unknown.published).toEqual(['Typed before drafts were shared']);
  const diverged = composer('Typed here');
  diverged.sync.remote({ text: 'Typed elsewhere', revision: 5 });
  await vi.advanceTimersByTimeAsync(800);
  expect(diverged.text()).toBe('Typed here');
  expect(diverged.published).toEqual([]);
  // An edit here decides.
  diverged.type('Typed here, then more');
  await vi.advanceTimersByTimeAsync(800);
  expect(diverged.published).toEqual(['Typed here, then more']);
});

it('keeps a draft over the shared bound on this device only', async () => {
  const page = composer();
  page.sync.remote(undefined);
  page.type('x'.repeat(8193));
  await vi.advanceTimersByTimeAsync(800);
  expect(page.published).toEqual([]);
});

it('retries a failed publish and stops once disposed', async () => {
  let fail = true;
  const published: string[] = [];
  const page = composer('', undefined, async value => { if (fail) throw new Error('offline'); published.push(value); return 9; });
  page.sync.remote(undefined);
  page.type('Ship it');
  await vi.advanceTimersByTimeAsync(800);
  expect(published).toEqual([]);
  fail = false;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(published).toEqual(['Ship it']);
  page.type('More');
  page.sync.dispose();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(published).toEqual(['Ship it']);
});
