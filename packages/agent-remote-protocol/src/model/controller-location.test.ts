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

it('round trips history intent independently of legacy keepOriginal', () => {
  for (const suffix of ['keepOriginal', 'keepOriginal=0', 'keepOriginal=legacy']) {
    const location = readControllerLocation(new URLSearchParams(`host=desk&provider=codex&session=A&intent=history&${suffix}`));
    expect(location).toEqual({ hostId: 'desk', providerId: 'codex', nativeSessionId: 'A', sessionIntent: 'history', keepOriginal: true });
    expect(controllerPath(location)).toBe('/?host=desk&provider=codex&session=A&intent=history&keepOriginal=1');
    expect(validControllerPath(controllerPath(location))).toBe(true);
  }
  expect(controllerPath({ hostId: 'desk', providerId: 'codex', nativeSessionId: 'A' })).not.toContain('intent');
});

it.each(['intent=ordinary', 'intent=', 'intent=history&intent=history', 'keepOriginal=1&keepOriginal=1', 'keepOriginal=%00'])('rejects invalid navigation options: %s', options => {
  expect(() => readControllerLocation(new URLSearchParams(`host=desk&provider=codex&session=A&${options}`))).toThrow();
});

it.each(['intent=history', 'keepOriginal', 'host=desk&preview=p&path=/&intent=history', 'host=desk&preview=p&path=/&keepOriginal=1'])('requires complete native identity for navigation options: %s', query => {
  expect(() => readControllerLocation(new URLSearchParams(query))).toThrow();
});


it('round trips a tunnel path through the existing login return location', () => {
  const location = { hostId: 'host', previewId: 'preview', previewPath: '/docs?q=one#section' };
  const path = controllerPath(location);
  expect(validControllerPath(path)).toBe(true);
  expect(readControllerLocation(new URLSearchParams(path.slice(2)))).toEqual(location);
});

it.each(['//evil.test/', '/../outside', '/%2e%2e/outside', '/\\evil.test/', 'https://evil.test/'])('rejects escaping preview paths %s', previewPath => {
  expect(() => controllerPath({ hostId: 'host', previewId: 'preview', previewPath })).toThrow();
});

it('rejects incomplete and mixed preview identities', () => {
  expect(() => controllerPath({ hostId: 'host', previewId: 'preview' })).toThrow();
  expect(() => controllerPath({ hostId: 'host', previewId: 'preview', previewPath: '/', agentId: 'agent' })).toThrow();
});

it('preserves a shared Window identity through controller and login return paths', () => {
  const location = readControllerLocation(new URLSearchParams('window=window-123'));
  expect(location).toEqual({ windowId: 'window-123' });
  expect(controllerPath(location)).toBe('/?window=window-123');
  expect(validControllerPath('/?window=window-123')).toBe(true);
  expect(() => readControllerLocation(new URLSearchParams('window=one&window=two'))).toThrow();
  expect(() => readControllerLocation(new URLSearchParams('window=invalid%2Fid'))).toThrow();
});
