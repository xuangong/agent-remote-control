import { expect, it } from 'vitest';
import { controllerPath, readControllerLocation, validControllerPath } from './controller-location.js';

it('round trips session identity while excluding credentials and arbitrary redirects', () => {
  const location = readControllerLocation(new URLSearchParams('host=desk&provider=claude&session=native%2Fid%3Fquery&parent=root&token=secret&returnTo=https://evil.example'));
  const path = controllerPath(location);
  expect(path).toBe('/?host=desk&provider=claude&session=native%2Fid%3Fquery&parent=root');
  expect(validControllerPath(path)).toBe(true);
  expect(readControllerLocation(new URLSearchParams(path.slice(2)))).toEqual(location);
  expect(validControllerPath('/')).toBe(true);
});

it.each(['//evil.example', '/auth/logout', '/?returnTo=https://evil.example', '/?host=desk&host=other', '/?provider=claude', '/?session=native', '/?host=%00'])('rejects unsafe or incomplete controller target %s', (value) => {
  expect(validControllerPath(value)).toBe(false);
});

it('keeps legacy Agent and Host-only links valid', () => {
  expect(controllerPath(readControllerLocation(new URLSearchParams('agent=live')))).toBe('/?agent=live');
  expect(controllerPath(readControllerLocation(new URLSearchParams('host=desk')))).toBe('/?host=desk');
});
