import type { TpmRecord } from '../tpm-store.js';

/** A valid saved TPM record, the starting point of the store tests. */
export function tpmRecord(): TpmRecord {
  return { version: 1, createKey: 'scope:op', createFingerprint: 'a', creation: 'prepared', requirement: 'goal', dirty: true, lastReviewAt: 0, actions: {},
    work: { id: 'test-work', revision: 1, title: 'Example', providerId: 'codex', mainNativeSessionId: 'main', phase: 'clarifying', waiting: 'none', paused: false, summary: '', nextAction: '', document: '', acceptance: '', evidence: [], createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', nextCheckAt: 0, outbox: [] } };
}
