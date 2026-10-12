import { createHash } from 'node:crypto';
import type { AgentSession, BackgroundActivity, ProviderObservation, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';

export interface BackgroundReviewRecord {
  id: string;
  inputHash: string;
  turnId?: string;
  result?: { notify: boolean; summary: string };
  failed?: boolean;
}
export const backgroundInputHash = (text: string) => createHash('sha256').update(text).digest('hex');
export interface BackgroundReviewAccess {
  records(): readonly BackgroundReviewRecord[];
  bind(id: string, turnId: string): Promise<void>;
  fail(id: string): Promise<void>;
}

/** Annotates application-owned input after native normalization. Never guesses native delivery. */
export function withBackgroundReviews(session: AgentSession, access: BackgroundReviewAccess): AgentSession {
  let source: readonly BackgroundReviewRecord[] | undefined;
  let byHash = new Map<string, BackgroundReviewRecord[]>();
  let byTurn = new Map<string, BackgroundReviewRecord>();
  function index() {
    const records = access.records();
    if (records === source) return;
    source = records; byHash = new Map(); byTurn = new Map();
    for (const record of records) {
      const candidates = byHash.get(record.inputHash) ?? []; candidates.push(record); byHash.set(record.inputHash, candidates);
      if (record.turnId) byTurn.set(record.turnId, record);
    }
  }
  async function identify(observation: ProviderObservation): Promise<void> {
    const event = observation.event;
    if (event.type !== 'timeline' || event.item.type !== 'user_message' || !event.turnId) return;
    const hash = backgroundInputHash(event.item.text);
    index();
    const candidates = byHash.get(hash) ?? [];
    if (candidates.length !== 1) return;
    const record = candidates[0]!;
    if (record.turnId === undefined) await access.bind(record.id, event.turnId);
  }
  async function annotate(observation: ProviderObservation): Promise<ProviderObservation> {
    await identify(observation);
    const event = observation.event;
    index();
    let record = 'turnId' in event && event.turnId ? byTurn.get(event.turnId) : undefined;
    if (!record) return observation;
    const interrupted = event.type === 'turn_completed' && !record.result || event.type === 'turn_failed' || event.type === 'turn_canceled' || event.type === 'interaction_requested'
      || event.type === 'timeline' && (event.item.type === 'error' || event.item.type === 'interaction'
        || event.item.type === 'tool_call' && (event.item.status === 'failed' || event.item.status === 'canceled'));
    if (!record.failed && interrupted) { await access.fail(record.id); index(); record = byTurn.get(record.turnId!) ?? record; }
    if (event.type !== 'timeline') return observation;
    // A human steer inside the same native turn is not background input.
    if (event.item.type === 'user_message' && backgroundInputHash(event.item.text) !== record.inputHash) {
      if (!record.failed) await access.fail(record.id);
      return observation;
    }
    const background: BackgroundActivity = { id: record.id, kind: 'review',
      status: record.failed ? 'failed' : record.result ? record.result.notify ? 'visible' : 'silent' : 'pending',
      ...(record.result ? { summary: record.result.summary } : {}) };
    return { ...observation, event: { ...event, item: { ...event.item, background } } };
  }
  let annotationUnavailable = false;
  async function safelyAnnotate(observation: ProviderObservation): Promise<ProviderObservation> {
    if (annotationUnavailable) return observation;
    try { return await annotate(observation); }
    catch { annotationUnavailable = true; return observation; }
  }
  async function page(observations: ProviderObservation[]) {
    if (annotationUnavailable) return observations;
    try {
      // A native page may list a turn's prompt after its other records.
      for (const observation of observations) await identify(observation);
      // Discover all failures/steers before annotating earlier rows from this page.
      for (const observation of observations) await annotate(observation);
      const annotated: ProviderObservation[] = [];
      for (const observation of observations) annotated.push(await annotate(observation));
      return annotated;
    } catch { annotationUnavailable = true; return observations; }
  }
  return new Proxy(session, {
    get(target, key) {
      if (key === 'observe') return async function* (): AsyncIterable<ProviderStreamItem> {
        const outcomes = new Map<string, BackgroundActivity['status']>();
        for await (const item of target.observe()) {
          if (item.type === 'observation') {
            const annotated = await safelyAnnotate(item);
            if (!annotationUnavailable && 'turnId' in item.event && item.event.turnId) {
              index();
              const record = byTurn.get(item.event.turnId);
              if (record) {
                const background: BackgroundActivity = { id: record.id, kind: 'review',
                  status: record.failed ? 'failed' : record.result ? record.result.notify ? 'visible' : 'silent' : 'pending',
                  ...(record.result ? { summary: record.result.summary } : {}) };
                if (outcomes.get(record.id) !== background.status) {
                  outcomes.set(record.id, background.status);
                  if (outcomes.size > 2048) outcomes.delete(outcomes.keys().next().value!);
                  yield { type: 'observation', sourceKey: `background:${record.id}:${background.status}`,
                    occurredAt: item.occurredAt, delivery: item.delivery,
                    event: { type: 'background_activity_updated', provider: item.event.provider, turnId: item.event.turnId, background } };
                }
              }
            }
            yield annotated;
          }
          else if (item.type === 'timeline_replacement') yield { ...item, observations: await page(item.observations) };
          else yield item;
        }
      };
      if (key === 'readTimelineHistory' && target.readTimelineHistory) return async (cursor: string) => {
        const history = await target.readTimelineHistory!(cursor);
        return { ...history, observations: await page(history.observations) };
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
