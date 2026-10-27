import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { render } from './test/setup.js';
import { createSessionExcerpt, splitSessionExcerpts, type ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { addQuote, readQuotes, removeQuotes, useViewQuotes, withViewQuotes } from './session-quotes.js';

afterEach(() => { localStorage.clear(); vi.useRealTimers(); });
const scope = 'https://example.test/';
const entry = (text: string) => ({ seqStart: 1, item: { type: 'user_message', text } }) as ProjectedTimelineEntry;
const excerpt = (id: string, text = 'quoted') => createSessionExcerpt({ id, capturedAt: 'now', entries: [entry(text)], selected: () => true,
  source: { hostId: 'host', providerId: 'codex', nativeSessionId: 'source', title: 'Source' } });

it('keeps quotes per session view, bounded to what one message carries', () => {
  addQuote(scope, 'view-a', excerpt('a')); addQuote(scope, 'view-a', excerpt('b')); addQuote(scope, 'view-b', excerpt('c'));
  expect(readQuotes(scope, 'view-a').map(item => item.id)).toEqual(['a', 'b']);
  expect(readQuotes(scope, 'view-b').map(item => item.id)).toEqual(['c']);
  removeQuotes(scope, 'view-a', ['a']);
  expect(readQuotes(scope, 'view-a').map(item => item.id)).toEqual(['b']);
  for (const id of ['d', 'e', 'f', 'g', 'h', 'i', 'j']) addQuote(scope, 'view-a', excerpt(id));
  expect(() => addQuote(scope, 'view-a', excerpt('k'))).toThrow('already carries 8 quotes');
  // Unreadable saved quotes are ignored rather than sent.
  localStorage.setItem(`agent-remote:recovery:${scope}:quotes`, JSON.stringify({ version: 1, views: { 'view-a': { updatedAt: Date.now(), excerpts: [{ id: 'bad' }, excerpt('ok')] } } }));
  expect(readQuotes(scope, 'view-a').map(item => item.id)).toEqual(['ok']);
});

it('lets quotes of closed views expire', () => {
  vi.useFakeTimers({ now: Date.parse('2026-10-01T00:00:00Z') });
  addQuote(scope, 'old', excerpt('a'));
  vi.setSystemTime(Date.parse('2026-11-05T00:00:00Z'));
  addQuote(scope, 'new', excerpt('b'));
  expect(readQuotes(scope, 'old')).toEqual([]);
  expect(readQuotes(scope, 'new').map(item => item.id)).toEqual(['b']);
});

it('sends the quotes with the next message after its text, and returns them when it cannot be sent', async () => {
  addQuote(scope, 'view', excerpt('a', 'first')); addQuote(scope, 'view', excerpt('b', 'second'));
  const sent: string[] = [];
  let fail = true;
  const actions = withViewQuotes({ sendMessage: async text => { if (fail) throw new Error('offline'); sent.push(text); } }, scope, 'view');
  let shown: string[] = [];
  function Quotes() { shown = useViewQuotes(scope, 'view').map(item => item.id); return null; }
  await render(<Quotes />);
  expect(shown).toEqual(['a', 'b']);
  await expect(actions.sendMessage!('Question')).rejects.toThrow('offline');
  expect(readQuotes(scope, 'view').map(item => item.id)).toEqual(['a', 'b']);
  fail = false;
  await act(async () => { await actions.sendMessage!('Question'); });
  expect(splitSessionExcerpts(sent[0]!)).toMatchObject({ text: 'Question', excerpts: [{ id: 'a' }, { id: 'b' }] });
  expect(shown).toEqual([]);
  await actions.sendMessage!('Next');
  expect(sent[1]).toBe('Next');
});

it('carries quotes as the last text part of a message with images', async () => {
  addQuote(scope, 'view', excerpt('a'));
  const content = vi.fn(async (_content: unknown, _options?: unknown) => {});
  await withViewQuotes({ sendMessageContent: content }, scope, 'view').sendMessageContent!([{ type: 'text', text: 'See ' }, { type: 'image', attachmentId: 'image', label: 'image #1' }]);
  const parts = content.mock.calls[0]![0] as Array<{ type: string; text?: string }>;
  expect(parts.slice(0, 2).map(part => part.type)).toEqual(['text', 'image']);
  expect(splitSessionExcerpts(parts[2]!.text!)).toMatchObject({ text: '', excerpts: [{ id: 'a' }] });
});
