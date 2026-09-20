import { controllerContentSecurityPolicy } from '@agent-remote-controller/agent-remote-hosted';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export async function createGatewayStaticPages(directory: string, options?: { origin: string; previewDomain?: string }) {
  const root = await realpath(directory);
  const index = (await readFile(resolve(root, 'index.html'), 'utf8')).replace('<head>', '<head><meta name="agent-remote-auth" content="gateway">');
  const types: Record<string, string> = { '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = new URL(request.url ?? '/', 'http://relay.local').pathname;
    if (path === '/' || path === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': controllerContentSecurityPolicy(options?.origin ?? 'http://localhost', options?.previewDomain) });
      response.end(index); return true;
    }
    if (!path.startsWith('/assets/') && !['/favicon.svg', '/app/manifest.webmanifest', '/app/icon-192.png', '/app/icon-512.png'].includes(path)) return false;
    let file: string;
    try { file = await realpath(resolve(root, '.' + decodeURIComponent(path))); } catch { return false; }
    if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) return false;
    const type = types[extname(file)]; if (!type) return false;
    response.writeHead(200, { 'content-type': type }); response.end(await readFile(file)); return true;
  };
}
