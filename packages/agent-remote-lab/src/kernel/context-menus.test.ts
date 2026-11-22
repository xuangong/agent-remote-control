import { describe, expect, it } from 'vitest';
import { chatMenu, messageMenu, type MessageMenuFacts } from './context-menus.js';

describe('chatMenu', () => {
  it.each([
    { name: 'an assistant in a group', facts: { pinned: false, muted: false, movable: true, grouped: true }, items: ['pin', 'mute', 'rename', 'move', 'leaveGroup'] },
    { name: 'a pinned, muted assistant offers to undo both', facts: { pinned: true, muted: true, movable: true, grouped: true }, items: ['unpin', 'unmute', 'rename', 'move', 'leaveGroup'] },
    { name: 'the default group has no group to leave', facts: { pinned: false, muted: false, movable: true, grouped: false }, items: ['pin', 'mute', 'rename', 'move'] },
    { name: 'a Side or a Team member stays where it is', facts: { pinned: false, muted: false, movable: false, grouped: true }, items: ['pin', 'mute', 'rename'] },
  ])('$name', ({ facts, items }) => {
    expect(chatMenu(facts)).toEqual(items);
  });
});

describe('messageMenu', () => {
  const base: MessageMenuFacts = { kind: 'reply', hasText: true, selectedInside: false, onLink: false, canQuote: true, canResend: true };
  it.each([
    { name: 'a reply copies and quotes', facts: {}, menu: ['copy', 'quote'] },
    { name: 'the person\'s sent message copies and quotes, and is not sent again', facts: { kind: 'mine' }, menu: ['copy', 'quote'] },
    { name: 'a message not sent copies, quotes and resends', facts: { kind: 'unsent' }, menu: ['copy', 'quote', 'resend'] },
    { name: 'no resend when the page cannot send', facts: { kind: 'unsent', canResend: false }, menu: ['copy', 'quote'] },
    { name: 'no quote when the composer takes no text', facts: { canQuote: false }, menu: ['copy'] },
    { name: 'text the reader selected keeps the browser\'s menu', facts: { selectedInside: true }, menu: 'native' },
    { name: 'a link keeps the browser\'s menu', facts: { onLink: true }, menu: 'native' },
    { name: 'a step of the work keeps the browser\'s menu', facts: { kind: 'other' }, menu: 'native' },
    { name: 'a reply with no text has nothing to offer', facts: { hasText: false }, menu: 'native' },
    { name: 'an image-only message not sent still resends', facts: { kind: 'unsent', hasText: false }, menu: ['resend'] },
  ] as const)('$name', ({ facts, menu }) => {
    expect(messageMenu({ ...base, ...facts })).toEqual(menu);
  });
});
