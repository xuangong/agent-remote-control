/**
 * The name an assistant is called by, in the sidebar, the top bar, the live line and a tile (I3b; the coordinator's naming
 * rule). A session's title is never the name: it is often the first prompt ("Reply with the words …"), and it stays the
 * conversation's subtitle.
 *
 * - A bot is called by its own name.
 * - A plain session (no bot) is called by its agent: "Claude", "Codex", "Copilot", or the agent's display name otherwise.
 * - Plain sessions of one agent shown together are numbered in the order given ("Claude", "Claude 2"); a number never
 *   repeats a name a bot or another session already has.
 */

export interface NamedAssistant {
  /** What tells this assistant apart from the others shown with it (a view id or a session key). */
  readonly key: string;
  /** The bot's own name, when the assistant is a bot. */
  readonly bot?: string;
  readonly providerId: string;
  /** The agent's display name as its Host reports it. */
  readonly providerName?: string;
}

const AGENTS: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot', opencode: 'OpenCode', gemini: 'Gemini' };

/** The short name of an agent: its known name, else its display name, else its id with a capital. */
export function agentName(providerId: string, providerName?: string): string {
  const known = AGENTS[providerId.toLowerCase()];
  if (known) return known;
  const display = providerName?.trim();
  if (display) return display;
  return providerId ? providerId.charAt(0).toUpperCase() + providerId.slice(1) : 'Assistant';
}

/** The names of assistants shown together, by key. */
export function assistantNames(assistants: readonly NamedAssistant[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const assistant of assistants) {
    const bot = assistant.bot?.trim();
    if (bot) { names.set(assistant.key, bot); taken.add(bot.toLowerCase()); }
  }
  const plain = assistants.filter(assistant => !assistant.bot?.trim() && !names.has(assistant.key));
  const byAgent = new Map<string, NamedAssistant[]>();
  for (const assistant of plain) {
    const agent = agentName(assistant.providerId, assistant.providerName);
    byAgent.set(agent, [...byAgent.get(agent) ?? [], assistant]);
  }
  for (const [agent, members] of byAgent) {
    let number = 1;
    for (const member of members) {
      let name = number === 1 ? agent : `${agent} ${number}`;
      while (taken.has(name.toLowerCase())) name = `${agent} ${++number}`;
      names.set(member.key, name); taken.add(name.toLowerCase()); number += 1;
    }
  }
  return names;
}

/** The name of one assistant among those shown with it (itself alone by default). */
export function assistantName(assistant: NamedAssistant, together: readonly NamedAssistant[] = [assistant]): string {
  const shown = together.some(item => item.key === assistant.key) ? together : [...together, assistant];
  return assistantNames(shown).get(assistant.key) ?? agentName(assistant.providerId, assistant.providerName);
}
