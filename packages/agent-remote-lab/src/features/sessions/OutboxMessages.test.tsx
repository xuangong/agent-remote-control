import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { OutboxEntry } from '@orchardworks/agent-remote-protocol';
import { render } from '../../test/setup.js';
import { OutboxMessages, waitingAge } from './OutboxMessages.js';

const now = Date.parse('2026-11-14T12:00:00Z');
const entry = (index: number, status: OutboxEntry['status'], extra: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`, hostId: 'mac', providerId: 'codex', nativeSessionId: 'thread',
  text: `Message ${index}`, createdAt: now - 30_000, status, ...extra });
const message = (container: HTMLElement, index: number) => container.querySelector<HTMLElement>(`[data-entry-key="outbox:${entry(index, 'waiting').id}"]`)!;
const delivery = (container: HTMLElement, index: number) => message(container, index).querySelector('.agent-message-delivery')!.textContent;

it('says how long a message has waited once it is over a minute', () => {
  expect(waitingAge(now - 30_000, now)).toBe('');
  expect(waitingAge(now - 5 * 60_000, now)).toBe('5 min');
  expect(waitingAge(now - 2 * 3_600_000, now)).toBe('2 h');
  expect(waitingAge(now - 3 * 86_400_000, now)).toBe('3 d');
});

it('shows each waiting message as an outgoing bubble not yet sent, with what it waits for and how to take it back', async () => {
  const onCancel = vi.fn(async () => {}), onRetry = vi.fn(async () => {});
  const entries = [entry(1, 'waiting'), entry(2, 'waiting', { createdAt: now - 2 * 3_600_000 }), entry(3, 'delivering')];
  const container = await render(<OutboxMessages entries={entries} hostName="Mac mini" hostOnline={false} now={now} onCancel={onCancel} onRetry={onRetry} />);
  expect(message(container, 1).textContent).toContain('Message 1');
  expect(delivery(container, 1)).toBe('Waiting for Mac mini');
  // A long wait shows its age.
  expect(delivery(container, 2)).toBe('Waiting for Mac mini · 2 h');
  expect(message(container, 1).dataset.deliveryState).toBe('waiting');
  // One the Host is delivering can no longer be taken back.
  expect(delivery(container, 3)).toBe('Sending…');
  expect(message(container, 3).querySelector('button')).toBeNull();
  expect(message(container, 3).getAttribute('aria-busy')).toBe('true');
  await act(async () => message(container, 1).querySelector<HTMLButtonElement>('[aria-label="Cancel message"]')!.click());
  expect(onCancel).toHaveBeenCalledWith(entries[0]!.id);
  const online = await render(<OutboxMessages entries={[entry(1, 'waiting')]} hostName="Mac mini" hostOnline now={now} onCancel={onCancel} onRetry={onRetry} />);
  expect(delivery(online, 1)).toBe('Waiting to send');
});

it('offers to send again a message that was not delivered, or whose delivery is unknown, and says why', async () => {
  const onCancel = vi.fn(async () => { throw new Error('The Host is delivering this message now.'); }), onRetry = vi.fn(async () => {});
  const entries = [entry(1, 'failed', { error: 'The session is not on this Host.' }), entry(2, 'unknown', { error: 'Check the conversation before sending it again.' })];
  const container = await render(<OutboxMessages entries={entries} hostName="Mac mini" hostOnline now={now} onCancel={onCancel} onRetry={onRetry} />);
  expect(message(container, 1).dataset.deliveryState).toBe('failed');
  expect(delivery(container, 1)).toContain('Not delivered');
  expect(delivery(container, 1)).toContain('The session is not on this Host.');
  expect(message(container, 2).dataset.deliveryState).toBe('unconfirmed');
  expect(delivery(container, 2)).toContain('Check delivery');
  await act(async () => message(container, 1).querySelector<HTMLButtonElement>('[aria-label="Send again"]')!.click());
  expect(onRetry).toHaveBeenCalledWith(entries[0]!.id);
  await act(async () => message(container, 2).querySelector<HTMLButtonElement>('[aria-label="Dismiss message"]')!.click());
  expect(onCancel).toHaveBeenCalledWith(entries[1]!.id);
  expect(message(container, 2).querySelector('[role="alert"]')?.textContent).toContain('The Host is delivering this message now.');
});
