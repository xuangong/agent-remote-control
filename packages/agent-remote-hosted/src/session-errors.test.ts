import {expect,it} from 'vitest';
import {sessionAttachFailure} from './session-errors.js';
it('forwards only public verified native owner identity for takeover failures',()=>{
  expect(sessionAttachFailure(JSON.stringify({code:'native_session_owned',nativeOwner:{kind:'native_cli',generation:'d1b6eec8-fdad-48d4-aa7d-13140586e519',token:'secret',port:80}}))).toMatchObject({code:'native_session_owned',nativeOwner:{kind:'native_cli',generation:'d1b6eec8-fdad-48d4-aa7d-13140586e519'}});
  expect(JSON.stringify(sessionAttachFailure(JSON.stringify({code:'native_session_owned',nativeOwner:{kind:'native_cli',generation:'d1b6eec8-fdad-48d4-aa7d-13140586e519',token:'secret'}})))).not.toContain('secret');
  expect(sessionAttachFailure(JSON.stringify({code:'native_session_owned',nativeOwner:{kind:'native_cli',generation:7}}))).not.toHaveProperty('nativeOwner');
});
