import { createHash } from 'node:crypto';
import { AgentOperationRejectedError } from '@orchardworks/agent-provider-sdk';
import type { MutationEntry } from '@orchardworks/agent-remote-relay';

/** Directory implementations report native completion before local grant/publication work. */
export interface DirectoryMutationEvidence { completed(): void }
export async function directoryNativeEffect<T>(entry: MutationEntry | undefined, targets: readonly string[],
  work: (evidence: DirectoryMutationEvidence) => Promise<T>): Promise<T> {
  const effects: import('@orchardworks/agent-remote-relay').NativeEffectHandle[] = [];
  try { if (entry) for (const target of targets) effects.push(entry.startNativeEffect(target)); }
  catch (error) { for (const effect of effects) effect.settled(); throw error; }
  let completed = false;
  const evidence = { completed() { completed = true; for (const effect of effects) effect.settled(); } };
  try { const result = await work(evidence); evidence.completed(); return result; }
  catch (error) {
    for (const effect of effects) {
      if (completed || error instanceof AgentOperationRejectedError) effect.settled(); else effect.unresolved();
    }
    throw error;
  }
}
/** Preserve durable non-UUID identities while scoping their cache adapter deterministically. */
export function directoryOperationId(identity: unknown): string {
  const bytes = createHash('sha256').update(JSON.stringify(identity)).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
