import {describe,expect,it} from 'vitest';
import {sessionAttachFailure, sessionSubscriptionRefusal} from './session-errors.js';
it('forwards only public verified native owner identity for takeover failures',()=>{
  expect(sessionAttachFailure(JSON.stringify({code:'native_session_owned',nativeOwner:{kind:'native_cli',generation:'d1b6eec8-fdad-48d4-aa7d-13140586e519',token:'secret',port:80}}))).toMatchObject({code:'native_session_owned',nativeOwner:{kind:'native_cli',generation:'d1b6eec8-fdad-48d4-aa7d-13140586e519'}});
  expect(JSON.stringify(sessionAttachFailure(JSON.stringify({code:'native_session_owned',nativeOwner:{kind:'native_cli',generation:'d1b6eec8-fdad-48d4-aa7d-13140586e519',token:'secret'}})))).not.toContain('secret');
  expect(sessionAttachFailure(JSON.stringify({code:'native_session_owned',nativeOwner:{kind:'native_cli',generation:7}}))).not.toHaveProperty('nativeOwner');
});

describe('session subscription refusal', () => {
  it.each([
    [409, { code: 'native_session_owned', error: 'This session is controlled by another native client. Take control to interrupt it and resume here.' }, 1008],
    [404, { code: 'native_session_unavailable', error: 'The native runtime could not find this session.' }, 1008],
    [403, undefined, 1008],
    [503, { code: 'native_runtime_unavailable', error: 'The native runtime connection is unavailable.' }, 1013],
    [429, undefined, 1013],
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
