import { act } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Team, TeamAction } from '@orchardworks/agent-remote-protocol';
import { render } from '../../test/setup.js';
import { BotRooms } from './BotRooms.js';

const NOW = 1_000_000_000;
const member = (id: string, name: string) => ({ id, role: 'member', hostId: 'mac', providerId: 'claude', nativeSessionId: id, name, responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 });
const room = (id: string, name: string, state: 'open' | 'done', updatedAt = NOW): Team => ({ id, operationId: id, revision: 1, title: name, status: state === 'open' ? 'active' : 'archived', createdAt: 1, updatedAt,
  source: { hostId: 'mac', providerId: 'claude', nativeSessionId: 'chief', title: 'Chief' }, members: [member('m1', 'Chief'), member('m2', 'Tracker')], messages: [],
  room: { name, state, speaker: state === 'open' ? 'm2' : undefined, transcript: [{ id: 'e1', from: 'm1', name: 'Chief', text: 'Ready to ship?', at: 1 }] } } as unknown as Team);
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

// The browser's modal dialog, which jsdom lacks.
beforeAll(async () => {
  await import('../team/RoomView.js');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
});

describe('rooms in Chats', () => {
  it('lists the open rooms the page keeps and those ended today, and opens one as a group chat where the person writes', async () => {
    const posted: TeamAction[] = [];
    const rooms = [room('r1', 'Release', 'open'), room('r2', 'Plan', 'done'), room('r3', 'Old', 'done', NOW - 2 * 24 * 60 * 60_000), { ...room('t', 'Task', 'open'), room: undefined } as Team];
    const client = { action: vi.fn(async (input: TeamAction) => { posted.push(input); return room('r1', 'Release', 'open'); }) };
    const container = await render(<BotRooms scope="/" rooms={rooms} client={client} now={() => NOW} />);
    await flush();
    expect([...container.querySelectorAll('[data-room] strong')].map(item => item.textContent)).toEqual(['Release', 'Plan']);
    expect(container.querySelector('[data-room="r1"] small')!.textContent).toBe('Open · 2 members');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-room="r1"]')!.click());
    expect(container.querySelector('.lab-room-transcript')!.textContent).toContain('Ready to ship?');
    const box = container.querySelector<HTMLTextAreaElement>('.lab-room-composer textarea')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Ship it.'); box.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => container.querySelector<HTMLButtonElement>('.lab-room-composer button[type="submit"]')!.click());
    await flush();
    expect(posted).toEqual([expect.objectContaining({ teamId: 'r1', action: 'room_post', text: 'Ship it.' })]);
  });

  it('shows nothing when the account has no rooms', async () => {
    const container = await render(<BotRooms scope="/" rooms={[]} client={{ action: async () => { throw new Error('unused'); } }} />);
    await flush();
    expect(container.querySelector('.lab-bot-rooms')).toBeNull();
  });
});
