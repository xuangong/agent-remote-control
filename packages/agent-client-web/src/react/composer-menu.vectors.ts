import type { ComposerMenuFacts, ComposerMenuItemId } from './composer-menu.js';

/** A plain session that is ready, with a text draft: the facts each row changes. */
export const READY: ComposerMenuFacts = {
  images: false, resources: false, resourceUpload: false, target: true, ready: true, readOnly: false, busy: false, firstInputPending: false,
  consoleCommands: false, queue: 'none', draft: { content: true, command: false, skill: false, imagesReady: true, waiting: 0, sendable: true }, settings: false,
};
const RICH: Partial<ComposerMenuFacts> = { images: true, resources: true, resourceUpload: true };
const QUEUE: Partial<ComposerMenuFacts> = { queue: 'allowed' };
const hint = { queue: 'composer.queueHint' } as const;
const draft = (change: Partial<ComposerMenuFacts['draft']>): Partial<ComposerMenuFacts> => ({ draft: { ...READY.draft, ...change } });

/** Each row: the facts that differ from READY, and the items in order as `id` (enabled) or `-id` (shown, disabled), with notes. */
export const COMPOSER_MENU_VECTORS: readonly { readonly name: string; readonly facts: Partial<ComposerMenuFacts>; readonly items: readonly string[]; readonly notes?: Partial<Record<ComposerMenuItemId, string>> }[] = [
  { name: 'a plain session offers commands only', facts: {}, items: ['command'] },
  { name: 'a rich session offers images, resources and commands', facts: RICH, items: ['image', 'resource', 'command'] },
  { name: 'a resource waits for the upload and the restored draft', facts: { ...RICH, resourceUpload: false }, items: ['image', '-resource', 'command'] },
  { name: 'while the session opens, an image can wait in the draft but a resource or command cannot', facts: { ...RICH, ready: false }, items: ['image', '-resource', '-command'] },
  { name: 'without a session nothing can be added', facts: { ...RICH, target: false, ready: false }, items: ['-image', '-resource', '-command'] },
  { name: 'a read-only session takes nothing', facts: { ...RICH, readOnly: true }, items: ['-image', '-resource', '-command'] },
  { name: 'a read-only session still runs the page\'s console commands', facts: { readOnly: true, consoleCommands: true }, items: ['command'] },
  { name: 'nothing while the composer is busy', facts: { ...RICH, ...QUEUE, busy: true }, items: ['-image', '-resource', '-command', '-queue'], notes: hint },
  { name: 'history waiting for the first message holds images, resources and queueing, and says why',
    facts: { ...RICH, ...QUEUE, firstInputPending: true }, items: ['-image', '-resource', 'command', '-queue'],
    notes: { image: 'composer.imagesAfterHistory', resource: 'composer.resourcesAfterHistory', queue: 'composer.queueAfterHistory' } },
  { name: 'a running turn queues a text for the next one', facts: QUEUE, items: ['command', 'queue'], notes: hint },
  { name: 'an empty draft cannot be queued', facts: { ...QUEUE, ...draft({ content: false }) }, items: ['command', '-queue'], notes: hint },
  { name: 'a command is not queued', facts: { ...QUEUE, ...draft({ command: true }) }, items: ['command', '-queue'], notes: hint },
  { name: 'a skill is not queued', facts: { ...QUEUE, ...draft({ skill: true }) }, items: ['command', '-queue'], notes: hint },
  { name: 'a message waiting to be sent goes first', facts: { ...QUEUE, ...draft({ waiting: 1 }) }, items: ['command', '-queue'], notes: hint },
  { name: 'images still uploading hold the queue', facts: { ...QUEUE, ...draft({ imagesReady: false }) }, items: ['command', '-queue'], notes: hint },
  { name: 'a provider that takes no message queues nothing', facts: { ...QUEUE, ...draft({ sendable: false }) }, items: ['command', '-queue'], notes: hint },
  { name: 'queueing the session refuses now is shown, not offered', facts: { queue: 'refused' }, items: ['command', '-queue'], notes: hint },
  { name: 'a session shown with its settings adds Model, Permissions and Status', facts: { ...RICH, settings: true },
    items: ['image', 'resource', 'command', 'model', 'permissions', 'status'] },
  { name: 'the settings stay open to read while the session is busy', facts: { settings: true, busy: true }, items: ['-command', 'model', 'permissions', 'status'] },
];
