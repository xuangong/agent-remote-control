import { createHash } from 'node:crypto';
import { AgentOperationRejectedError, type AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

/** Compare native extension contracts while allowing Host callbacks to be recreated. */
export function sessionExtensionIdentity(extensions: AgentSessionExtensions = {}): string {
  const contract = {
    instructions: extensions.instructions ?? null,
    systemPrompt: extensions.systemPrompt ?? null,
    tools: [...(extensions.tools ?? [])].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
  return createHash('sha256').update(JSON.stringify(canonical(contract))).digest('hex');
}

export function requireSessionExtensionIdentity(identity: string | undefined, requested: AgentSessionExtensions | undefined): void {
  // Ordinary browser attachment does not request a new Host extension binding.
  if (requested === undefined || identity === sessionExtensionIdentity(requested)) return;
  throw new AgentOperationRejectedError('session_extensions_mismatch',
    'Session extensions differ from the open native runtime. Explicitly close and reopen the session before binding these extensions.');
}
