import { afterEach, expect, it, vi } from 'vitest';
import { ConversationStorage, storageKeys } from './conversation-storage.js';
import { ForkStore } from './session-forks.js';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

it('lists every key of a storage, reading a conversation storage inventory once', () => {
  for (let index = 0; index < 50; index++) localStorage.setItem(`agent-remote:recovery:scope:item-${index}`, 'x');
  localStorage.setItem('unrelated', 'x');
  const storage = new ConversationStorage(() => localStorage);
  const inventory = vi.spyOn(storage, 'keys');
  expect(storageKeys(storage)).toHaveLength(50);
  expect(inventory).toHaveBeenCalledTimes(1);
  expect(storageKeys(localStorage)).toHaveLength(51);
});

it('scans its records with one inventory, however many other conversation keys the browser keeps', () => {
  for (let index = 0; index < 300; index++) localStorage.setItem(`agent-remote:recovery:scope:item-${index}`, 'x');
  const storage = new ConversationStorage(() => localStorage);
  const inventory = vi.spyOn(storage, 'keys');
  expect(new ForkStore('https://relay.example/', storage).allLocal()).toEqual([]);
  expect(inventory).toHaveBeenCalledTimes(1);
});
