/**
 * A bot's memory (bots step 8c): short facts it learned, kept beside its mission. Only the bot's own sessions and the person write
 * it; a call here always acts on the bot that made it, so no other bot is ever named.
 */
import { randomUUID } from 'node:crypto';
import { BOT_MEMORY_FACTS, type BotFact } from '@orchardworks/agent-remote-protocol';

const fail = (message: string): never => { throw new Error(message); };
const fold = (text: string) => text.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en');
export const newFactId = () => 'f' + randomUUID().replaceAll('-', '').slice(0, 8);
/** The fact a reference means: its id, or its exact text. */
const find = (memory: readonly BotFact[], ref: string) => memory.find(fact => fact.id === ref) ?? memory.find(fact => fold(fact.text) === fold(ref));

/** Adds a fact, or replaces the one `replace` names; the same text twice is one fact. */
export function remembered(memory: readonly BotFact[], text: string, replace?: string, id: () => string = newFactId): { memory: BotFact[]; fact: BotFact } {
  const clean = text.replace(/\s+/g, ' ').trim() || fail('A fact needs some text.');
  if (replace !== undefined) {
    const old = find(memory, replace) ?? fail('No fact of yours has that id or text; read your memory in your standing instructions.');
    const fact = { id: old.id, text: clean };
    return { memory: memory.map(item => item === old ? fact : item).filter(item => item === fact || fold(item.text) !== fold(clean)), fact };
  }
  const same = memory.find(fact => fold(fact.text) === fold(clean));
  if (same) return { memory: [...memory], fact: same };
  if (memory.length >= BOT_MEMORY_FACTS) fail(`Your memory holds ${BOT_MEMORY_FACTS} facts; forget one first.`);
  const fact = { id: id(), text: clean };
  return { memory: [...memory, fact], fact };
}
/** Removes the fact a reference names. */
export function forgotten(memory: readonly BotFact[], ref: string): { memory: BotFact[]; fact: BotFact } {
  const fact = find(memory, ref) ?? fail('No fact of yours has that id or text.');
  return { memory: memory.filter(item => item !== fact), fact };
}
