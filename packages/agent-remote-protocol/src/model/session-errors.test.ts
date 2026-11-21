import {describe,expect,it} from 'vitest';
import {sessionAttachFailure, sessionSubscriptionRefusal} from './session-errors.js';
it('forwards only public verified native owner identity for takeover failures',()=>{
  expect(sessionAttachFailure(JSON.stringify({code:'native_session_owned',nativeOwner:{kind:'native_cli',generation:'d1b6eec8-fdad-48d4-aa7d-13140586e519',token:'secret',port:80}}))).toMatchObject({code:'native_session_owned',nativeOwner:{kind:'native_cli',generation:'d1b6eec8-fdad-48d4-aa7d-13140586e519'}});
  expect(JSON.stringify(sessionAttachFailure(JSON.stringify({code:'native_session_owned',nativeOwner:{kind:'native_cli',generation:'d1b6eec8-fdad-48d4-aa7d-13140586e519',token:'secret'}})))).not.toContain('secret');
  expect(sessionAttachFailure(JSON.stringify({code:'native_session_owned',nativeOwner:{kind:'native_cli',generation:7}}))).not.toHaveProperty('nativeOwner');
  // A generation that is not a UUID is dropped, so the page cannot tell that a terminal holds the session and offers a plain take-over
  // that the Controller refuses again. Every owner the Controller records is a UUID; a test double must use one too.
  expect(sessionAttachFailure(JSON.stringify({code:'native_session_owned',nativeOwner:{kind:'native_cli',generation:'terminal-1'}}))).not.toHaveProperty('nativeOwner');
});

describe('session subscription refusal', () => {
  it.each([
    [409, { code: 'native_session_owned', error: 'This session is controlled by another native client. Take control to interrupt it and resume here.' }, 1008],
    [404, { code: 'native_session_unavailable', error: 'The native runtime could not find this session.' }, 1008],
    [403, undefined, 1008],
    [503, { code: 'native_runtime_unavailable', error: 'The native runtime connection is unavailable.' }, 1013],
    [429, { code: 'session_stream_capacity', error: 'Too many sessions are open across your browsers and devices (limit 64).' }, 4029],
  ])('closes a %i refusal with a code that separates permanent from retryable failure', async (status, body, code) => {
    const closure = await sessionSubscriptionRefusal(new Response(body ? JSON.stringify(body) : null, { status }));
    expect(closure.code).toBe(code);
    expect(closure.reason).toBe(body?.error ?? 'Session subscription is unavailable.');
  });

  it('keeps the reason short enough for a channel frame and ignores non-JSON bodies', async () => {
    expect((await sessionSubscriptionRefusal(new Response(JSON.stringify({ error: 'x'.repeat(4000) }), { status: 409 }))).reason.length).toBeLessThanOrEqual(240);
    expect(await sessionSubscriptionRefusal(new Response('<html>', { status: 409 }))).toEqual({ code: 1008, reason: 'Session subscription is unavailable.' });
    expect(await sessionSubscriptionRefusal(undefined)).toEqual({ code: 1008, reason: 'Session subscription is unavailable.' });
  });
});

describe('session attach failure', () => {
  it.each(['native_usage_limited', 'native_auth_missing', 'native_exited', 'native_unresponsive'])('gives the typed runtime failure %s its fixed words', code => {
    const failure = sessionAttachFailure(JSON.stringify({ code, error: 'native text that may carry content' }));
    expect(failure.code).toBe(code);
    expect(failure.error).toMatch(/^The native CLI /);
    expect(failure.error).not.toContain('content');
  });

  it('keeps when a usage limit resets, and only a time a date can hold, and only for a usage limit (gap 3)', () => {
    expect(sessionAttachFailure(JSON.stringify({ code: 'native_usage_limited', resetsAt: 1_800_000_000_000 }))).toMatchObject({ code: 'native_usage_limited', resetsAt: 1_800_000_000_000 });
    expect(sessionAttachFailure(JSON.stringify({ code: 'native_usage_limited', resetsAt: -1 }))).not.toHaveProperty('resetsAt');
    expect(sessionAttachFailure(JSON.stringify({ code: 'native_usage_limited', resetsAt: '2026-11-22T10:00:00Z' }))).not.toHaveProperty('resetsAt');
    expect(sessionAttachFailure(JSON.stringify({ code: 'native_exited', resetsAt: 1_800_000_000_000 }))).not.toHaveProperty('resetsAt');
  });
});

describe('a session in use', () => {
  it("keeps the CLI's reason and wait, with words that name the active writer and offer a retry, never a take-over (O48)", () => {
    const failure = sessionAttachFailure(JSON.stringify({ code: 'session_in_use', error: 'thread 1 already has an active writer', reason: 'writer_elsewhere', retryAfterMs: 5000 }));
    expect(failure).toEqual({ code: 'session_in_use', error: expect.stringMatching(/active writer.*retry/), nativeRefusal: { reason: 'writer_elsewhere', retryAfterMs: 5000 } });
    expect(failure).not.toHaveProperty('nativeOwner');
    expect(sessionAttachFailure(JSON.stringify({ code: 'session_in_use', reason: 'turn_running' })).nativeRefusal).toEqual({ reason: 'turn_running' });
  });

  it('keeps the fixed words of a refusal without a reason it knows, and drops a wait it cannot vouch for', () => {
    expect(sessionAttachFailure(JSON.stringify({ code: 'session_in_use', reason: 'busy' }))).toEqual({ code: 'session_in_use', error: 'This session is in use by another native client. Close that client, then reopen the session.' });
    expect(sessionAttachFailure(JSON.stringify({ code: 'session_in_use', reason: 'writer_elsewhere', retryAfterMs: -1 })).nativeRefusal).toEqual({ reason: 'writer_elsewhere' });
  });
});
