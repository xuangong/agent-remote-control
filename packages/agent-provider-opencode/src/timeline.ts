import type { ProviderObservation, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { fingerprint } from './normalize.js';

export interface SupplementalObservation { observation: ProviderObservation; after?: string; }

/** Native corrections replace history; ordinary native lifecycle changes remain append-only observations. */
export function reconcileTimeline(previous: ProviderObservation[], next: ProviderObservation[], supplemental: SupplementalObservation[], initialized: boolean, olderCursor?: string, pagedSnapshot = false): ProviderStreamItem[] {
  const prior = new Map(previous.map(item => [item.sourceKey, item]));
  const incoming = new Set(next.map(item => item.sourceKey));
  const surviving = previous.filter(item => incoming.has(item.sourceKey)).map(item => item.sourceKey);
  const expected = next.filter(item => prior.has(item.sourceKey)).map(item => item.sourceKey);
  const lastExisting = next.reduce((last, item, index) => prior.has(item.sourceKey) ? index : last, -1);
  const insertedBeforeExisting = next.some((item, index) => index < lastExisting && !prior.has(item.sourceKey));
  const removed = previous.filter(item => !incoming.has(item.sourceKey));
  const firstSurvivor = previous.findIndex(item => incoming.has(item.sourceKey));
  const trimmedPrefix = pagedSnapshot && olderCursor && firstSurvivor >= 0 && removed.length === firstSurvivor;
  const replace = (): ProviderStreamItem[] => [{ type: 'timeline_replacement', observations: orderedSnapshot(next, supplemental), ...(olderCursor ? { olderCursor } : {}) }];
  if (initialized && (insertedBeforeExisting || (removed.length && !trimmedPrefix) || surviving.some((key, index) => key !== expected[index]))) return replace();
  const changes: ProviderStreamItem[] = [];
  for (const item of next) {
    const old = prior.get(item.sourceKey);
    if (old && fingerprint(old.event) === fingerprint(item.event)) continue;
    const delivery = initialized ? 'live' : 'history';
    if (!old) { changes.push({ ...item, delivery }); continue; }
    if (old.event.type !== 'timeline' || item.event.type !== 'timeline') return replace();
    const before = old.event.item; const after = item.event.item;
    if ((before.type === 'assistant_message' && after.type === 'assistant_message') || (before.type === 'reasoning' && after.type === 'reasoning')) {
      if (!after.text.startsWith(before.text)) return replace();
      const delta = after.text.slice(before.text.length);
      if (delta) changes.push({ ...item, sourceKey: `${item.sourceKey}:text:${after.text.length}:${fingerprint(after.text)}`, delivery, event: { ...item.event, item: { ...after, text: delta } } });
    } else if ((before.type === 'tool_call' && after.type === 'tool_call' && before.callId === after.callId) || (before.type === 'compaction' && after.type === 'compaction')) {
      changes.push({ ...item, sourceKey: `${item.sourceKey}:state:${fingerprint(item.event)}`, delivery });
    } else return replace();
  }
  return changes;
}

export function orderedSnapshot(native: ProviderObservation[], supplemental: SupplementalObservation[]): ProviderObservation[] {
  const result = supplemental.filter(item => item.after === undefined).map(item => item.observation);
  const pending = supplemental.filter(item => item.after !== undefined);
  for (const observation of native) {
    result.push(observation);
    for (let index = 0; index < pending.length;) {
      if (pending[index]!.after === observation.sourceKey) result.push(pending.splice(index, 1)[0]!.observation);
      else index++;
    }
  }
  return result;
}
