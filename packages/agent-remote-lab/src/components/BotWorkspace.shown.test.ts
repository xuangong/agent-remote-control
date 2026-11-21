import { expect, it } from 'vitest';
import { botConversationShown } from './BotWorkspace.js';

const bot = { kind: 'bot' as const, groupId: 'g', viewId: 'v' };

it('shows the conversation of a chosen bot beside the list on a wide screen', () => {
  expect(botConversationShown({ place: bot, phone: false, rosterVisible: true, unavailable: false })).toBe(true);
});

it('shows the list alone, with no conversation and so no Back, when nothing or only a section is chosen', () => {
  expect(botConversationShown({ phone: false, rosterVisible: true, unavailable: false })).toBe(false);
  expect(botConversationShown({ place: { kind: 'section', groupId: 'g' }, phone: true, rosterVisible: true, unavailable: false })).toBe(false);
});

it('shows the list alone when the chosen bot became unavailable, on a wide screen and on a phone', () => {
  for (const phone of [false, true]) expect(botConversationShown({ place: bot, phone, rosterVisible: !phone, unavailable: true })).toBe(false);
});

it('shows one screen at a time on a phone: the conversation once the list is left, the list again after Back', () => {
  expect(botConversationShown({ place: bot, phone: true, rosterVisible: false, unavailable: false })).toBe(true);
  expect(botConversationShown({ place: bot, phone: true, rosterVisible: true, unavailable: false })).toBe(false);
});
