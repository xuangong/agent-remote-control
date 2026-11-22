import { expect, it } from 'vitest';
import { createWindowView, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { accountNames } from './assistant-names.js';
import { shownAssistantName, windowTitle } from './window-title.js';

const group: WindowGroup = {
  window: { schemaVersion: 3, id: 'notes', revision: 0, title: 'Notes', selectedPrimaryViewId: 'chief', selectedViewId: 'chief', views: [
    createWindowView('chief', { hostId: 'mac', providerId: 'claude', nativeSessionId: 'chief-session', title: 'Reply with OK and nothing else' }, 'primary')] },
  bots: { rank: 'm', members: { chief: { name: 'Chief' } } },
};
const names = accountNames([group]);
const session = { hostId: 'mac', providerId: 'claude', nativeSessionId: 'other', title: 'A prompt used as a title' };

it.each([
  ['an assistant', 'Chief', 'Chief · Orchard'],
  ['a name with spaces around it', '  Chief  ', 'Chief · Orchard'],
  ['no name', undefined, 'Orchard'],
  ['a blank name', '   ', 'Orchard'],
])('titles the window for %s', (_name, shown, title) => {
  expect(windowTitle(shown)).toBe(title);
});

it.each([
  ['a bot by its name, not its session\'s title', { kind: 'bot', groupId: 'notes', viewId: 'chief' }, true, 'Chief'],
  ['a session by its assistant\'s generated name, never the prompt', { kind: 'session', session }, true, names.session(session)],
  ['a group\'s list', { kind: 'section', groupId: 'notes' }, true, undefined],
  ['nothing chosen', undefined, true, undefined],
  ['a phone at the list, with the chat behind it', { kind: 'bot', groupId: 'notes', viewId: 'chief' }, false, undefined],
] as const)('names %s', (_name, place, shown, expected) => {
  expect(shownAssistantName(place, shown, names)).toBe(expected);
  if (expected) expect(expected).not.toContain('prompt');
});
