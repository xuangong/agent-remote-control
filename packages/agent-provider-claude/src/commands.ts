import { validateCommandDirectory, type AgentCommand } from '@orchardworks/agent-provider-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { record } from './projector.js';

// The native SDK returns a flat command list without structured skill provenance.
const sessionCommands = new Set(['clear', 'compact', 'context', 'debug', 'extra-usage', 'heapdump', 'init', 'loop', 'schedule', 'usage', 'cost', 'stats',
  'resume', 'fork', 'model', 'permissions', 'login', 'logout', 'exit', 'quit', 'agents', 'mcp', 'config', 'settings']);

/** What `/goal` takes: the condition to meet, or `clear`; with no argument it shows the goal. */
export const GOAL_INPUT_HINT = 'Condition to meet, or clear';

export async function discoverClaudeCommands(native: Pick<Query, 'reloadSkills' | 'supportedCommands'>): Promise<AgentCommand[]> {
  await native.reloadSkills();
  const entries: unknown = await native.supportedCommands();
  if (!Array.isArray(entries) || entries.length > 4096) throw new Error('Invalid Claude command directory.');
  const commands = new Map<string, AgentCommand>();
  for (const entry of entries) {
    if (!record(entry) || typeof entry.name !== 'string' || !/^[^\s/]+$/u.test(entry.name)
      || typeof entry.description !== 'string' || entry.argumentHint !== undefined && typeof entry.argumentHint !== 'string') {
      throw new Error('Invalid Claude command directory.');
    }
    if (sessionCommands.has(entry.name) && entry.name !== 'compact') continue;
    // `/goal` is a command of the session, not a skill: it sets, shows and clears the session's goal, and runs as typed.
    const hint = entry.argumentHint || (entry.name === 'goal' ? GOAL_INPUT_HINT : undefined);
    if (!commands.has(entry.name)) commands.set(entry.name, { id: `claude:${encodeURIComponent(entry.name)}`, name: entry.name,
      description: entry.description, kind: sessionCommands.has(entry.name) || entry.name === 'goal' ? 'command' : 'skill',
      ...(hint ? { inputHint: hint } : {}) });
  }
  return validateCommandDirectory([...commands.values()].sort((a, b) => a.name.localeCompare(b.name)));
}
