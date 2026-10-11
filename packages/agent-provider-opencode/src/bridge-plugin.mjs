import { readFile, lstat } from 'node:fs/promises';

/** Static native tools read current Host authority for every invocation and heartbeat. */
export default {
  id: 'agent-remote-control',
  async setup(context) {
    const configPath = context.options?.configPath;
    if (typeof configPath !== 'string' || typeof context.options?.serverUrl !== 'string') throw new Error('ARC callback plugin requires configPath and serverUrl.');
    const nativeUrl = new URL(context.options.serverUrl);
    if (nativeUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(nativeUrl.hostname) || nativeUrl.username || nativeUrl.password || nativeUrl.search || nativeUrl.hash) throw new Error('ARC callbacks require an explicit local native server.');
    const serverUrl = nativeUrl.toString().replace(/\/$/, '');
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
    const nativePath = (nativeContext, action) => {
      if (typeof nativeContext.sessionID !== 'string' || !nativeContext.sessionID) throw new Error('ARC callback requires native session context.');
      return `/sessions/${encodeURIComponent(nativeContext.sessionID)}/${action}`;
    };
    const registration = await context.tool.transform(editor => {
      editor.add({ name: 'arc_host_discover', description: 'Discover Host callbacks authorized for this native session. No callbacks are available without a Host grant.',
        options: { codemode: false },
        input: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_args, nativeContext) { return { content: JSON.stringify(await request(nativePath(nativeContext, 'discover'))) }; } });
      editor.add({ name: 'arc_host_invoke', description: 'Invoke a callback returned by arc_host_discover, using its exact name and JSON arguments. The native session identity is supplied by OpenCode.',
        options: { codemode: false },
        input: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 64 }, arguments: { type: 'object', additionalProperties: true } }, required: ['name', 'arguments'], additionalProperties: false },
        async execute(args, nativeContext) { const result = await request(nativePath(nativeContext, 'invoke'), { method: 'POST', body: JSON.stringify({ name: args.name, arguments: args.arguments }) }); return { content: result.output }; } });
    });
    const ready = () => request('/ready', { method: 'POST', body: JSON.stringify({ version: 1, serverUrl, directory: context.location.directory }) }).catch(() => undefined);
    await ready();
    const heartbeat = setInterval(ready, 2000); heartbeat.unref?.();
    return async () => { clearInterval(heartbeat); await registration.dispose(); };
  },
};
