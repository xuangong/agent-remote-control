/** The composer: the capsule, its + menu, sending, queueing, attachments and commands. */
import type { Message } from '../types.js';

export const composer = {
  // Why an item of the + menu waits, and what queueing does.
  'composer.imagesAfterHistory': 'The first message must contain only text. Images can be sent after the previous history is included.',
  'composer.resourcesAfterHistory': 'Resources can be sent after the previous history is included.',
  'composer.queueAfterHistory': 'The first message must use immediate delivery.',
  'composer.queueHint': 'Let the native Provider handle this after the current turn',
} as const satisfies Readonly<Record<string, Message>>;
