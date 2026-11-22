/**
 * The name an assistant is called by, everywhere it shows: the sidebar, the top bar, the live line, a tile and the details
 * (I3c, the coordinator's naming rule). A session's title is never the name: it is often the first prompt ("Reply with the
 * words …"), and it stays the conversation's subtitle and a row of the sessions list.
 *
 * The rule is the protocol's (`chooseAssistantNames`), which the Relay also follows to name assistants in push reminders; this
 * module gives it the default names in the reader's words from the catalogue (`name.<id>`), which are the protocol's words.
 */
import { chooseAssistantNames, type AssistantNameId, type NamedAssistant } from '@orchardworks/agent-remote-protocol';
import { translator, type MessageKey, type Translate } from './messages.js';

export { ASSISTANT_NAME_IDS, assistantNameIndex, type AssistantNameId, type NamedAssistant } from '@orchardworks/agent-remote-protocol';

const english = translator('en');
const nameKey = (id: AssistantNameId) => `name.${id}` as MessageKey;

/** The names the assistants of one account are called by, by key, in the language of `t`. */
export function assistantNames(assistants: readonly NamedAssistant[], t: Translate = english): ReadonlyMap<string, string> {
  return chooseAssistantNames(assistants, id => t(nameKey(id)));
}

/** The name of one assistant among the others of its account (itself alone by default). */
export function assistantName(assistant: NamedAssistant, account: readonly NamedAssistant[] = [assistant], t: Translate = english): string {
  const all = account.some(item => item.key === assistant.key) ? account : [...account, assistant];
  return assistantNames(all, t).get(assistant.key)!;
}
