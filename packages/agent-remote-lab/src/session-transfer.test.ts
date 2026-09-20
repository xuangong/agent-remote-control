import { expect, it } from 'vitest';
import { readSessionCode } from './session-transfer.js';
const origin = 'https://agents.example';

it('uses stable native identity and preserves child references while ignoring old bindings', () => {
  expect(readSessionCode(`${origin}/?host=mac&provider=codex&session=native-1&agent=stale&parent=native-parent`, origin))
    .toEqual({ hostId: 'mac', providerId: 'codex', nativeSessionId: 'native-1', parentNativeSessionId: 'native-parent' });
});
it.each([
  'https://other.example/?host=mac&provider=codex&session=one',
  'javascript:alert(1)', 'not a QR code',
  `${origin}/?host=mac&provider=codex`,
  `${origin}/?host=mac&provider=codex&session=one&session=two`,
  `${origin}/?host=mac&preview=one&path=/`,
  `${origin}/auth/callback?host=mac&provider=codex&session=one`,
  'https://user:password@agents.example/?host=mac&provider=codex&session=one',
])('rejects invalid or foreign navigation: %s', value => {
  expect(() => readSessionCode(value, origin)).toThrow();
});
