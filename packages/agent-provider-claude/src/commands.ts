import { validateCommandDirectory, type AgentCommand } from '@borgee/agent-provider-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { record } from './projector.js';

// The native SDK returns a flat command list without structured skill provenance.
const sessionCommands = new Set(['clear', 'compact', 'context', 'debug', 'extra-usage', 'heapdump', 'init', 'loop', 'schedule', 'usage', 'cost', 'stats',
  'resume', 'fork', 'model', 'permissions', 'login', 'logout', 'exit', 'quit', 'agents', 'mcp', 'config', 'settings']);

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
    if (!commands.has(entry.name)) commands.set(entry.name, { id: `claude:${encodeURIComponent(entry.name)}`, name: entry.name,
      description: entry.description, kind: sessionCommands.has(entry.name) ? 'command' : 'skill',
      ...(entry.argumentHint ? { inputHint: entry.argumentHint } : {}) });
  }
  return validateCommandDirectory([...commands.values()].sort((a, b) => a.name.localeCompare(b.name)));
}
