import type { RelayEnvironment } from './relay-object.js';
export { RelayObject } from './relay-object.js';

const controllerPolicy = "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";
export default {
  async fetch(request: Request, env: RelayEnvironment): Promise<Response> {
    const url = new URL(request.url);
    const controlOrigin = new URL(env.AGENT_REMOTE_RELAY_URL).origin;
    const previewOrigin = new URL(env.AGENT_REMOTE_PREVIEW_URL || controlOrigin).origin;
    if (url.origin !== controlOrigin) {
      if (url.origin === previewOrigin) return env.RELAY.getByName('primary').fetch(request);
      return new Response(null, { status: 403 });
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && !request.headers.has('upgrade')) {
      if ((url.pathname === '/' || url.pathname === '/index.html') && !url.searchParams.has('preview')) {
        url.pathname = '/index.html';
        const asset = await env.ASSETS.fetch(new Request(url, { method: 'GET' }));
        if (!asset.ok) return new Response('Controller assets are unavailable.', { status: 503 });
        const index = (await asset.text()).replace(/<head(?:\s[^>]*)?>/i, '$&<meta name="agent-remote-auth" content="gateway">');
        if (!index.includes('<meta name="agent-remote-auth" content="gateway">')) return new Response('Controller assets are invalid.', { status: 503 });
        return new Response(request.method === 'HEAD' ? null : index, { headers: {
          'content-type': 'text/html; charset=utf-8', 'content-security-policy': controllerPolicy,
          'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
        } });
      }
      if (url.pathname.startsWith('/assets/') || ['/favicon.svg', '/app/manifest.webmanifest', '/app/icon-192.png', '/app/icon-512.png'].includes(url.pathname)) {
        const asset = await env.ASSETS.fetch(request);
        // Static asset fallback must never expose the ordinary unauthenticated workbench index.
        if (asset.headers.get('content-type')?.includes('text/html')) return new Response(null, { status: 404 });
        return asset;
      }
    }
    return env.RELAY.getByName('primary').fetch(request);
  },
} satisfies ExportedHandler<RelayEnvironment>;
