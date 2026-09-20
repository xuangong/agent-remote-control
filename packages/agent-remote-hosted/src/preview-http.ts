interface Route { id: string; target: string; pathMode: 'strip' | 'preserve'; root?: boolean }
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const privateCookie = (name: string) => /^(?:__Host-|__Secure-)?arc[_-]/i.test(name.trim());
export function previewRequest(request: Request, route: Route) {
  const url = new URL(request.url); const prefix = route.root ? '' : `/p/${route.id}`;
  if (!url.pathname.startsWith(prefix + '/') && url.pathname !== prefix) throw new Error('Preview path does not match registration.');
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method)) throw new Error('HTTP method is unsupported.');
  const excluded = new Set([...hopHeaders, 'host', 'referer', 'forwarded']);
  // Isolated origins carry only the application's Authorization header; legacy paths share the Relay origin.
  if (!route.root) excluded.add('authorization');
  for (const value of (request.headers.get('connection') ?? '').split(',')) excluded.add(value.trim().toLowerCase());
  const headers: Array<[string, string]> = [];
  request.headers.forEach((value, name) => {
    if (excluded.has(name) || name.startsWith('x-forwarded-') || name.startsWith('sec-websocket-') || name.startsWith('x-arc-') || name.startsWith('cf-')) return;
    if (name === 'cookie') {
      const app = value.split(';').filter(cookie => !privateCookie(cookie.split('=', 1)[0]!)).map(cookie => cookie.trim()).join('; ');
      if (app) headers.push([name, app]);
    } else headers.push([name, name === 'origin' ? route.target : value]);
  });
  return { method: request.method, path: (route.root || route.pathMode === 'preserve' ? url.pathname : url.pathname.slice(prefix.length) || '/') + url.search,
    headers, ...(request.body ? { body: request.body } : {}), signal: request.signal };
}

export function previewResponseHeaders(input: Array<[string, string]>, route: Route, requestPath: string): Headers {
  const prefix = route.root ? '' : `/p/${route.id}`;
  const excluded = new Set(hopHeaders);
  for (const [name, value] of input) if (name.toLowerCase() === 'connection') for (const part of value.split(',')) excluded.add(part.trim().toLowerCase());
  const output = new Headers();
  for (const [rawName, value] of input) {
    const name = rawName.toLowerCase();
    if (excluded.has(name) || name === 'clear-site-data' || name === 'service-worker-allowed' || name === 'cdn-cache-control' || name === 'cloudflare-cdn-cache-control') continue;
    if (name === 'location') {
      const destination = new URL(value, route.target + requestPath);
      if (destination.origin === route.target) {
        const path = route.root || route.pathMode === 'preserve' && destination.pathname.startsWith(prefix + '/') ? destination.pathname : prefix + destination.pathname;
        output.append(name, path + destination.search + destination.hash);
      } else {
        if (['127.0.0.1', 'localhost', '[::1]'].includes(destination.hostname)) throw new Error('Redirect requires a separate preview registration.');
        output.append(name, destination.href);
      }
    } else if (name === 'set-cookie') {
      const parts = value.split(';').map(value => value.trim());
      if (privateCookie(parts[0]!.split('=', 1)[0]!) || (!route.root && parts[0]!.startsWith('__Host-'))) continue;
      const pathPart = parts.find(part => /^path=/i.test(part));
      const original = pathPart?.slice(5) || '/';
      const path = route.pathMode === 'preserve' && original.startsWith(prefix + '/') ? original : prefix + (original.startsWith('/') ? original : '/');
      output.append(name, [...parts.filter(part => !/^(domain|path)=/i.test(part)), `Path=${path}`].join('; '));
    } else output.append(name, value);
  }
  output.set('cache-control', 'private, no-store');
  output.set('referrer-policy', 'no-referrer'); output.set('x-content-type-options', 'nosniff');
  return output;
}
