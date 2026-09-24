import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

export function localRequestAllowed(request: IncomingMessage, url: string): boolean {
  return !!url && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')
    && request.headers.host === new URL(url).host
    && (request.headers.origin === undefined || request.headers.origin === url);
}

export async function serveAssets(request: IncomingMessage, response: ServerResponse, assets: string, path: string) {
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
  const file = resolve(assets, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(`${assets}${sep}`)) { response.writeHead(404).end(); return; }
  let bytes: Buffer;
  try { bytes = await readFile(file); } catch { response.writeHead(404).end(); return; }
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:*; frame-ancestors 'none'");
  response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  response.end(request.method === 'HEAD' ? undefined : bytes);
}

export async function openBrowser(url: string) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url], { stdio: 'ignore', timeout: 5000 });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Could not open browser. Open the printed URL manually.')));
  });
}
