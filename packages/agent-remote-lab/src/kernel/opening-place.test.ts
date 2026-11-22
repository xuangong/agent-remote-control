import { expect, it } from 'vitest';
import { lastBotPlaceKey, openingBotPlace } from './opening-place.js';

const chief = { kind: 'bot', groupId: 'notes', viewId: 'chief' } as const;
const builder = { kind: 'bot', groupId: 'notes', viewId: 'builder' } as const;
const session = { kind: 'session', session: { hostId: 'mac', providerId: 'claude', nativeSessionId: 's1', title: 'Old notes' } } as const;

it.each([
  ['a reload keeps the tab\'s chat', { place: chief, rosterVisible: false }, { place: builder, rosterVisible: false }, { place: chief, rosterVisible: false }],
  ['a reload at the list stays at the list', { place: null, rosterVisible: true }, { place: builder, rosterVisible: false }, { rosterVisible: true }],
  ['a new window opens the device\'s last chat', null, { place: builder, rosterVisible: false }, { place: builder, rosterVisible: false }],
  ['the installed app opens the device\'s last session', undefined, { place: session, rosterVisible: false }, { place: session, rosterVisible: false }],
  ['a tab record that cannot be read gives way to the device\'s', { place: { kind: 'bot' } }, { place: chief, rosterVisible: false }, { place: chief, rosterVisible: false }],
  ['a section place shows the list', null, { place: { kind: 'section', groupId: 'notes' }, rosterVisible: true }, { place: { kind: 'section', groupId: 'notes' }, rosterVisible: true }],
  ['a record without the list flag shows the list', null, { place: chief }, { place: chief, rosterVisible: true }],
  ['nothing kept: the list, nothing chosen', null, null, { rosterVisible: true }],
  ['nothing readable: the list, nothing chosen', 'chief', 42, { rosterVisible: true }],
] as const)('%s', (_name, tab, device, expected) => {
  expect(openingBotPlace(tab, device)).toEqual(expected);
});

it('keeps the device\'s record under a content prefix of the account\'s scope', () => {
  expect(lastBotPlaceKey('https://relay.example/u/alice/')).toBe('agent-remote:recovery:https://relay.example/u/alice/:last-bot-place');
});
