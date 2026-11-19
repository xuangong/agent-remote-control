// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { classifyCreationFailure, mayCreate, mayResume, partialCreationMessage, planningOption, reservationFor, resumedSession, sessionQuotaReached } from './agent-creation.js';

describe('when a session may be created', () => {
  const ready = { providerId: 'codex', unavailableReason: undefined, opening: false, bot: false, hasDirectory: false };
  it('needs a provider, an available catalog and no other opening', () => {
    expect(mayCreate(ready)).toBe(true);
    expect(mayCreate({ ...ready, providerId: undefined })).toBe(false);
    expect(mayCreate({ ...ready, providerId: '' })).toBe(false);
    expect(mayCreate({ ...ready, unavailableReason: 'offline' })).toBe(false);
    expect(mayCreate({ ...ready, opening: true })).toBe(false);
  });
  it('needs a directory for a bot only', () => {
    expect(mayCreate({ ...ready, bot: true })).toBe(false);
    expect(mayCreate({ ...ready, bot: true, hasDirectory: true })).toBe(true);
  });
});

describe('the reservation a retry reuses', () => {
  const fresh = () => ({ operationId: 'fresh' });
  it('is the held one for an ordinary attempt, bot or not', () => {
    expect(reservationFor<{ operationId: string; bot?: true }, { operationId: string }>({ operationId: 'held' }, false, fresh)).toEqual({ operationId: 'held' });
    expect(reservationFor<{ operationId: string; bot?: true }, { operationId: string }>({ operationId: 'held', bot: true }, false, fresh)).toEqual({ operationId: 'held', bot: true });
  });
  it('is new for an ordinary attempt that holds nothing', () => expect(reservationFor(undefined, false, fresh)).toEqual({ operationId: 'fresh' }));
  it('is the held one for a bot attempt only when it is a bot reservation', () => {
    expect(reservationFor<{ operationId: string; bot?: true }, { operationId: string }>({ operationId: 'held', bot: true }, true, fresh)).toEqual({ operationId: 'held', bot: true });
    expect(reservationFor<{ operationId: string; bot?: true }, { operationId: string }>({ operationId: 'held' }, true, fresh)).toEqual({ operationId: 'fresh' });
    expect(reservationFor(undefined, true, fresh)).toEqual({ operationId: 'fresh' });
  });
  it('does not make a new reservation when it keeps the held one', () => {
    let made = 0;
    reservationFor<{ operationId: string; bot?: true }, object>({ operationId: 'held' }, false, () => { made += 1; return {}; });
    expect(made).toBe(0);
  });
});

describe('planning in a new session', () => {
  it('is requested when asked for, except for dsh', () => {
    expect(planningOption(true, 'codex')).toEqual({ planning: true });
    expect(planningOption(true, 'dsh')).toEqual({});
    expect(planningOption(false, 'codex')).toEqual({});
  });
});

describe('a failed creation', () => {
  const failure = { directoryError: true, hasDirectory: true, reservationHeld: true, bot: false, botSessionCreated: false, message: 'Boom.' };
  it.each(['invalid_request', 'workspace_not_found', 'provider_not_found', 'session_quota_exceeded', 'operation_conflict'])('releases the reservation for %s and does not promise a retry', code => {
    expect(classifyCreationFailure({ ...failure, code })).toEqual({ releasesReservation: true, partialNotice: false, failure: 'Boom.' });
  });
  it('keeps the reservation for any other failure and says Retry keeps it', () => {
    expect(classifyCreationFailure({ ...failure, code: 'unavailable' })).toEqual({ releasesReservation: false, partialNotice: false,
      failure: 'Boom. Retry keeps the same session reservation and settings.' });
  });
  it('does not promise a retry without a directory or without a held reservation', () => {
    expect(classifyCreationFailure({ ...failure, hasDirectory: false }).failure).toBe('Boom.');
    expect(classifyCreationFailure({ ...failure, reservationHeld: false }).failure).toBe('Boom.');
  });
  it('treats an error that is not a directory error as holding the reservation', () => {
    expect(classifyCreationFailure({ ...failure, directoryError: false, code: 'invalid_request' })).toMatchObject({ releasesReservation: false, partialNotice: false });
  });
  it('raises a notice, not a failure line, for the native file limit, and keeps the reservation', () => {
    expect(classifyCreationFailure({ ...failure, code: 'native_file_limit' })).toEqual({ releasesReservation: false, partialNotice: true });
    expect(partialCreationMessage('Too many files.')).toBe('Too many files. Creation may have partially completed. Inspect the native session list before creating a new intent. Retry keeps the same reservation.');
  });
  it('shows a bot\'s failure in the New bot sheet before its session exists, and not in the failure line', () => {
    expect(classifyCreationFailure({ ...failure, code: 'unavailable', bot: true })).toEqual({ releasesReservation: false, partialNotice: false,
      botSheetFailure: 'Boom. Retry keeps the same session reservation and settings.' });
  });
  it('shows nothing for a bot whose session exists: the roster shows the group state', () => {
    expect(classifyCreationFailure({ ...failure, code: 'unavailable', bot: true, botSessionCreated: true })).toEqual({ releasesReservation: false, partialNotice: false });
  });
});

describe('resuming a session', () => {
  it('needs persistence, a session that is not a child, and nothing else opening', () => {
    expect(mayResume({ hasPersistence: true, isChild: false, opening: false })).toBe(true);
    expect(mayResume({ hasPersistence: false, isChild: false, opening: false })).toBe(false);
    expect(mayResume({ hasPersistence: true, isChild: true, opening: false })).toBe(false);
    expect(mayResume({ hasPersistence: true, isChild: false, opening: true })).toBe(false);
  });
  const persistence = { providerId: 'codex', sessionId: 'native' };
  it('keeps what is known of the opened session and takes the Host\'s answer', () => {
    expect(resumedSession({ title: 'Mine', hostId: 'h1', agentId: 'old', providerId: 'x', nativeSessionId: 'old' } as { title: string; hostId?: string }, persistence, { agentId: 'new', nativeSessionId: 'n2' }))
      .toEqual({ title: 'Mine', hostId: 'h1', agentId: 'new', providerId: 'codex', nativeSessionId: 'n2' });
  });
  it('falls back to the persisted native id, the local Host and a title', () => {
    expect(resumedSession(undefined, persistence, { agentId: 'new' })).toEqual({ agentId: 'new', providerId: 'codex', nativeSessionId: 'native', hostId: 'local', title: 'Resumed session' });
  });
});

describe('the session quota', () => {
  it('is reached when used meets the limit, and not without a quota', () => {
    expect(sessionQuotaReached({ used: 3, limit: 3 })).toBe(true);
    expect(sessionQuotaReached({ used: 4, limit: 3 })).toBe(true);
    expect(sessionQuotaReached({ used: 2, limit: 3 })).toBe(false);
    expect(sessionQuotaReached(undefined)).toBe(false);
  });
});
