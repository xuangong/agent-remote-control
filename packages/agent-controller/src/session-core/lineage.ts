import type { AgentEmptyCreationResult, AgentPersistenceHandle } from '@orchardworks/agent-provider-sdk';
import { serializeAgentEmptyCreationResult } from '@orchardworks/agent-provider-sdk';
import { nativeSessionRefKey, type NativeSessionRef } from '@orchardworks/agent-remote-protocol';

import { nativePrefixResumeHandle, successionCreationHandle } from '../local-succession-preparation.js';
import type { SessionSuccessionStore } from '../session-succession-store.js';

/**
 * Lineage: what the succession records say about how a session came to exist.
 *
 * Contract. A succession operation names the session it started from (`from`), the candidate it created (`to`, or the orphan candidate of
 * an operation that did not commit) and the evidence of that creation. For a target session these answer:
 * - `originalCreation`: the native creation result its attachments must be opened with. Evidence that is not resumable (no outcome, or `not_dispatched`)
 *   is an error; two operations naming the same target with different results are an error.
 * - `originalNativePrefix`: the saved prefix handle and the source it was cut from, for a session made by a prompt edit. A prefix without its
 *   original handle, or with a creation result as well, is an error; two operations that disagree are an error.
 * - `genericSuccessionSource`: the source whose role a generic successor took over, while that succession is pending or after it committed.
 *   Two sources are an error.
 * A target no operation names answers nothing. Without a store (a Controller with no succession) every answer is nothing.
 *
 * Pure over the store's records; the store is a port that only these three reads use.
 */
export type LineageStore = Pick<SessionSuccessionStore, 'all' | 'progress'>;

const same = (left: NativeSessionRef, right: NativeSessionRef): boolean => nativeSessionRefKey(left) === nativeSessionRefKey(right);

export function originalCreation(store: LineageStore | undefined, target: NativeSessionRef): AgentEmptyCreationResult | undefined {
  let result: AgentEmptyCreationResult | undefined;
  for (const state of store?.all() ?? []) for (const operation of state.operations) {
    const progress = store!.progress(operation.operationId);
    const candidate = operation.to ?? progress?.orphanCandidate;
    if (!candidate || !same(candidate, target)) continue;
    const evidence = progress?.nativeCreation;
    if (!evidence) continue;
    const outcome = evidence.outcome;
    if (!outcome || outcome.status === 'not_dispatched') throw new Error('Native creation evidence is not resumable.');
    successionCreationHandle(target.providerId, target.nativeSessionId, outcome);
    if (result && serializeAgentEmptyCreationResult(result) !== serializeAgentEmptyCreationResult(outcome)) throw new Error('Native creation attachment identity conflicts.');
    result = outcome;
  }
  return result;
}

export function originalNativePrefix(store: LineageStore | undefined, target: NativeSessionRef): { handle: AgentPersistenceHandle; source: NativeSessionRef } | undefined {
  let result: { handle: AgentPersistenceHandle; source: NativeSessionRef } | undefined;
  for (const state of store?.all() ?? []) for (const operation of state.operations) {
    const progress = store!.progress(operation.operationId), candidate = operation.to ?? progress?.orphanCandidate;
    if (!candidate || !same(candidate, target) || !operation.preparation) continue;
    if (!progress?.nativePrefix?.handle || progress.nativeCreation) throw new Error('Original native prefix evidence is unavailable.');
    const handle = nativePrefixResumeHandle(target.providerId, target.nativeSessionId, progress.nativePrefix.handle);
    if (result && (JSON.stringify(result.handle) !== JSON.stringify(handle) || !same(result.source, operation.from))) throw new Error('Native prefix attachment identity conflicts.');
    result = { handle, source: operation.from };
  }
  return result;
}

/** The source a generic successor took its role over from, while that succession is pending or once it committed. */
export function genericSuccessionSource(store: LineageStore | undefined, target: NativeSessionRef): NativeSessionRef | undefined {
  let result: NativeSessionRef | undefined;
  for (const state of store?.all() ?? []) for (const operation of state.operations) {
    const progress = store!.progress(operation.operationId), candidate = operation.to ?? progress?.orphanCandidate;
    if (!candidate || !same(candidate, target) || operation.preparation) continue;
    if (result && !same(result, operation.from)) throw new Error('Generic succession source identity conflicts.');
    result = operation.from;
  }
  return result;
}
