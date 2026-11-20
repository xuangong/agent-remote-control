import type { NamedAssistant } from './assistant-name.js';

/** Assistants shown together and the names they are called by, row by row. Read by `assistant-name.test.ts`. */
export interface AssistantNameVector { readonly name: string; readonly assistants: readonly NamedAssistant[]; readonly names: readonly string[] }

const plain = (key: string, providerId: string, providerName?: string): NamedAssistant => ({ key, providerId, ...(providerName ? { providerName } : {}) });
const bot = (key: string, name: string, providerId = 'claude'): NamedAssistant => ({ key, bot: name, providerId });

export const ASSISTANT_NAME_VECTORS: readonly AssistantNameVector[] = [
  { name: 'a bot is called by its own name', assistants: [bot('a', 'Chief')], names: ['Chief'] },
  { name: 'a plain Claude session is Claude, never its prompt', assistants: [plain('a', 'claude', 'Claude Code')], names: ['Claude'] },
  { name: 'Codex and Copilot by their short names', assistants: [plain('a', 'codex', 'Codex CLI'), plain('b', 'copilot', 'GitHub Copilot CLI')], names: ['Codex', 'Copilot'] },
  { name: 'an unknown agent by its display name', assistants: [plain('a', 'recorded', 'Recorded')], names: ['Recorded'] },
  { name: 'an unknown agent without a display name by its id', assistants: [plain('a', 'dsh')], names: ['Dsh'] },
  { name: 'two plain sessions of one agent are numbered in order', assistants: [plain('a', 'claude'), plain('b', 'claude')], names: ['Claude', 'Claude 2'] },
  { name: 'numbering is per agent', assistants: [plain('a', 'claude'), plain('b', 'codex'), plain('c', 'claude'), plain('d', 'codex')], names: ['Claude', 'Codex', 'Claude 2', 'Codex 2'] },
  { name: 'bots are not numbered and keep their names', assistants: [bot('a', 'Builder'), plain('b', 'claude'), bot('c', 'Reviewer')], names: ['Builder', 'Claude', 'Reviewer'] },
  { name: 'a plain session never takes a bot\'s name', assistants: [bot('a', 'Claude'), plain('b', 'claude'), plain('c', 'claude')], names: ['Claude', 'Claude 2', 'Claude 3'] },
  { name: 'a number never repeats a bot\'s name', assistants: [bot('a', 'Claude 2'), plain('b', 'claude'), plain('c', 'claude')], names: ['Claude 2', 'Claude', 'Claude 3'] },
  { name: 'a bot with an empty name is a plain session', assistants: [bot('a', '  ', 'codex')], names: ['Codex'] },
];
