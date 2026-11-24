/**
 * Mentions in the composer (bots plan 8d): `@Name text` asks the bot Name from this conversation instead of writing to it. Pure: the
 * composer passes the account's bots in.
 */
export interface MentionBot { readonly botId: string; readonly name: string }

const fold = (text: string) => text.trim().toLocaleLowerCase('en').replace(/\s+/g, ' ');
const spaces = /\s+/g;

/**
 * The bot a draft that starts with `@Name ` names, and what is asked. The longest name wins, so "Release Manager" is not "Release";
 * a name is followed by a space, and something must follow it.
 */
export function parseMention(draft: string, bots: readonly MentionBot[]): { bot: MentionBot; text: string } | undefined {
  const text = draft.trimStart();
  if (!text.startsWith('@')) return undefined;
  const rest = text.slice(1);
  let found: { bot: MentionBot; length: number } | undefined;
  for (const bot of bots) {
    const words = bot.name.trim().replace(spaces, ' ');
    if (!words) continue;
    const head = rest.slice(0, words.length).replace(spaces, ' ');
    if (fold(head) !== fold(words) || rest.length === words.length || !/\s/.test(rest[words.length]!)) continue;
    if (!found || words.length > found.length) found = { bot, length: words.length };
  }
  const question = found ? rest.slice(found.length).trim() : '';
  return found && question ? { bot: found.bot, text: question } : undefined;
}

/** The bots the picker offers while the draft is only `@` and the start of a name: those whose name starts with what is typed. */
export function mentionCandidates(draft: string, bots: readonly MentionBot[]): readonly MentionBot[] {
  const text = draft.trimStart();
  if (!text.startsWith('@') || /\n/.test(text)) return [];
  const rest = text.slice(1), typed = fold(rest);
  // A space after the typed name closes the picker: the person is writing the question.
  if (typed !== '' && /\s$/.test(rest)) return [];
  return bots.filter(bot => fold(bot.name).startsWith(typed));
}

/** The draft after choosing a bot: its name, a space, and the cursor ready for the question. */
export const chooseMention = (bot: MentionBot): string => `@${bot.name.trim()} `;
