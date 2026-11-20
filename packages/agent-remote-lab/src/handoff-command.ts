import { withMessageKey } from '@orchardworks/agent-client';
export const handoffCommand = {
  id: 'console:handoff', name: 'handoff', kind: 'command' as const,
  description: 'Continue this conversation in a new session, optionally with another provider',
  descriptionKey: 'client.fork.handoffDescription',
};

export function handoffProvider(args: string): string | undefined {
  const value = args.trim();
  if (!value) return undefined;
  if (!/^[a-z][a-z0-9-]*$/i.test(value)) throw withMessageKey(new Error('Use /handoff or /handoff <provider>, for example /handoff claude.'), 'client.fork.handoffUsage');
  return value.toLowerCase();
}
