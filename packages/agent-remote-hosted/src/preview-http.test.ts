import { expect, it } from 'vitest';
import { previewRequest, previewResponseHeaders } from './preview-http.js';
const registration = { id: 'abc', target: 'http://127.0.0.1:3000', pathMode: 'strip' as const };
it('keeps query and application cookies while stripping Relay credentials and connection-nominated headers', () => {
  const request = new Request('https://preview.example/p/abc/me?q=1&q=2', { headers: {
    cookie: '__Secure-arc_preview_abc=secret; app=value; __Host-arc_session=private', authorization: 'Bearer private',
    connection: 'keep-alive, x-private', 'x-private': 'secret', origin: 'https://preview.example',
  } });
  const result = previewRequest(request, registration);
  expect(result.path).toBe('/me?q=1&q=2');
  expect(Object.fromEntries(result.headers)).toEqual({ cookie: 'app=value', origin: 'http://127.0.0.1:3000' });
  expect(previewRequest(request, { ...registration, pathMode: 'preserve' }).path).toBe('/p/abc/me?q=1&q=2');
}, 10000);
it('rewrites same-target redirects and scopes independent application cookies without changing binary representation headers', () => {
  const headers = previewResponseHeaders([['location', '/next?a=1'], ['set-cookie', 'app=one; Domain=localhost; Path=/; HttpOnly'],
    ['set-cookie', '__Secure-arc_preview_abc=forged; Path=/'], ['content-encoding', 'gzip'], ['content-length', '23']], registration, '/me');
  expect(headers.get('location')).toBe('/p/abc/next?a=1');
  expect(headers.getSetCookie()).toEqual(['app=one; HttpOnly; Path=/p/abc/']);
  expect(headers.get('content-encoding')).toBe('gzip'); expect(headers.get('content-length')).toBe('23');
}, 10000);

it('prevents authenticated preview responses from entering shared or persistent caches', () => {
  const headers = previewResponseHeaders([['cache-control', 'public, max-age=86400'], ['cdn-cache-control', 'public'], ['cloudflare-cdn-cache-control', 'public']], registration, '/image.png');
  expect(headers.get('cache-control')).toBe('private, no-store');
  expect(headers.has('cdn-cache-control')).toBe(false);
  expect(headers.has('cloudflare-cdn-cache-control')).toBe(false);
}, 10000);

it('preserves isolated application authorization and cookie paths while filtering Relay cookies', () => {
  const route = { ...registration, root: true };
  const request = new Request('https://t-one.preview.test/api?q=1', { headers: {
    authorization: 'Bearer app-token', cookie: '__Host-arc_preview=private; __Host-arc_challenge_one=private; app=one',
  } });
  const outgoing = previewRequest(request, route);
  expect(outgoing.path).toBe('/api?q=1');
  expect(Object.fromEntries(outgoing.headers)).toEqual({ authorization: 'Bearer app-token', cookie: 'app=one' });
  const response = previewResponseHeaders([['set-cookie', '__Host-app=one; Path=/; Secure'], ['set-cookie', 'section=two; Domain=localhost; Path=/docs'],
    ['set-cookie', '__Host-arc_preview=forged; Path=/; Secure'], ['location', '/next?q=1']], route, '/api?q=1');
  expect(response.getSetCookie()).toEqual(['__Host-app=one; Secure; Path=/', 'section=two; Path=/docs']);
  expect(response.get('location')).toBe('/next?q=1');
});
