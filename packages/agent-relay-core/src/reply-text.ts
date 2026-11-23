import { BOT_MESSAGE_LIMIT } from '@orchardworks/agent-remote-protocol';

/**
 * A bot's final text as the reply it sends (bots design 3.3): whole when it fits the 300 characters a message between bots may
 * have, otherwise cut so that the cut and a pointer to the rest, the replier's conversation, fit them. The turn that wrote the
 * text is over, so the Relay cuts it instead of refusing it.
 */
export function cutReply(text: string, bot: string): string {
  if (text.length <= BOT_MESSAGE_LIMIT) return text;
  const pointer = ` … [cut; read the rest of ${bot}'s answer with read_bot]`;
  return `${text.slice(0, Math.max(0, BOT_MESSAGE_LIMIT - pointer.length)).trimEnd()}${pointer}`;
}
