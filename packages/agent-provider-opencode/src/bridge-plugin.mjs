import { readFile, lstat } from 'node:fs/promises';
import { z } from 'zod';

/** Static native tools read current Host authority for every invocation and heartbeat. */
export default async function agentRemotePlugin(input, options) {
  const configPath = options?.configPath;
  if (typeof configPath !== 'string') throw new Error('ARC callback plugin requires configPath.');
  const serverUrl = new URL(input.serverUrl).toString().replace(/\/$/, '');
  async function request(path, init = {}) {
    const stat = await lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('ARC callback config is not private.');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const url = new URL(config.baseUrl);
    if (config.version !== 1 || config.serverUrl !== serverUrl || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('ARC callback configuration does not match this native server.');
    const response = await fetch(new URL(path, url), { ...init, redirect: 'error', signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' } });
    const text = await response.text();
    if (text.length > 150000) throw new Error('ARC callback response exceeds the limit.');
    if (!response.ok) throw new Error(`ARC Host callback unavailable (HTTP ${response.status}).`);
    return JSON.parse(text);
  }
  const ready = () => request('/ready', { method: 'POST', body: JSON.stringify({ version: 1, serverUrl, directory: input.directory }) }).catch(() => undefined);
  await ready();
  const heartbeat = setInterval(ready, 2000); heartbeat.unref?.();
  const nativePath = (context, action) => {
    if (typeof context.sessionID !== 'string' || !context.sessionID) throw new Error('ARC callback requires native session context.');
    return `/sessions/${encodeURIComponent(context.sessionID)}/${action}`;
  };
  return { dispose() { clearInterval(heartbeat); }, tool: {
    arc_host_discover: { description: 'Discover Host callbacks authorized for this native session. No callbacks are available without a Host grant.', args: {},
      async execute(_args, context) { return JSON.stringify(await request(nativePath(context, 'discover'))); } },
    arc_host_invoke: { description: 'Invoke a callback returned by arc_host_discover, using its exact name and JSON arguments. The native session identity is supplied by OpenCode.',
      args: { name: z.string().min(1).max(64), arguments: z.record(z.string(), z.unknown()) },
      async execute(args, context) { const result = await request(nativePath(context, 'invoke'), { method: 'POST', body: JSON.stringify({ name: args.name, arguments: args.arguments }) }); return result.output; } },
  } };
}
