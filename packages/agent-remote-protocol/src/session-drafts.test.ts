import { expect, it } from 'vitest';
import { decodeSessionChannelServerMessage } from './codec.js';
import { SESSION_DRAFT_BYTES, SESSION_DRAFT_LIMIT, isSessionDraft, isSessionDraftRequest, sessionDraftBytes } from './session-drafts.js';

const ref = { hostId: 'host', providerId: 'codex', nativeSessionId: 'thread' };

it('accepts a draft text up to its byte bound, an empty text meaning cleared', () => {
  expect(isSessionDraftRequest({ ...ref, text: 'Ship the release notes' })).toBe(true);
  expect(isSessionDraftRequest({ ...ref, text: '' })).toBe(true);
  expect(isSessionDraftRequest({ ...ref, text: 'a'.repeat(SESSION_DRAFT_BYTES) })).toBe(true);
  expect(isSessionDraftRequest({ ...ref, text: 'a'.repeat(SESSION_DRAFT_BYTES + 1) })).toBe(false);
  // Characters outside ASCII take more than one byte: the bound is on bytes, not characters.
  const wide = '草'.repeat(Math.floor(SESSION_DRAFT_BYTES / 3) + 1);
  expect(wide.length).toBeLessThan(SESSION_DRAFT_BYTES);
  expect(sessionDraftBytes(wide)).toBeGreaterThan(SESSION_DRAFT_BYTES);
  expect(isSessionDraftRequest({ ...ref, text: wide })).toBe(false);
  for (const invalid of [{ ...ref, hostId: '', text: 'x' }, { ...ref, text: 'x', title: 'Secret' }, { ...ref }]) expect(isSessionDraftRequest(invalid)).toBe(false);
});

it('gives each stored draft a revision', () => {
  expect(isSessionDraft({ ...ref, text: 'Draft', revision: 1 })).toBe(true);
  expect(isSessionDraft({ ...ref, text: '', revision: 9 })).toBe(true);
  for (const revision of [0, -1, 1.5]) expect(isSessionDraft({ ...ref, text: 'Draft', revision })).toBe(false);
  expect(isSessionDraft({ ...ref, text: 'a'.repeat(SESSION_DRAFT_BYTES + 1), revision: 1 })).toBe(false);
});

it('shares drafts on the session channel', () => {
  const frame = (fields: Record<string, unknown>) => decodeSessionChannelServerMessage(JSON.stringify({ protocolVersion: '1.8.0', type: 'session_drafts', ...fields })).status;
  const draft = { ...ref, text: 'Draft', revision: 3 };
  expect(frame({ snapshot: true, drafts: [draft] })).toBe('ok');
  expect(frame({ drafts: [draft] })).toBe('ok');
  expect(frame({ snapshot: true, drafts: [] })).toBe('ok');
  expect(frame({ drafts: Array.from({ length: SESSION_DRAFT_LIMIT + 1 }, (_, index) => ({ ...draft, nativeSessionId: `thread-${index}` })) })).not.toBe('ok');
  expect(frame({ drafts: [{ ...draft, revision: 0 }] })).not.toBe('ok');
});
