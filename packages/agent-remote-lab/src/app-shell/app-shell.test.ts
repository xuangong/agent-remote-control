// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { appShellWorker, DIRECT_ROUTES, routeOf, shellCacheName, type AppShell, type ShellCache, type ShellCaches, type ShellRequest } from './app-shell.js';

const ORIGIN = 'https://orchard.example';
const get = (path: string, mode = 'cors', origin = ORIGIN): ShellRequest => ({ method: 'GET', url: origin + path, mode });

describe('which requests the worker answers', () => {
  it.each([
    ['the app\'s page', get('/', 'navigate'), 'page'],
    ['the app\'s page at a place', get('/?mode=bot&section=notes&bot=chief', 'navigate'), 'page'],
    ['the index by name', get('/index.html', 'navigate'), 'page'],
    ['a built bundle', get('/assets/App-1a2b3c.js'), 'bundle'],
    ['a built stylesheet', get('/assets/index-9f8e.css'), 'bundle'],
    ['a preview opened at the root', get('/?preview=abc', 'navigate'), 'navigation'],
    ['sign-in', get('/auth/login', 'navigate'), 'navigation'],
    ['a preview page', get('/p/abc/', 'navigate'), 'navigation'],
    ['the file frame', get('/file-frame', 'navigate'), 'navigation'],
    ['the API', get('/v1/remote/hosts'), 'pass'],
    ['an account\'s API', get('/u/alice/v1/windows'), 'pass'],
    ['the access status', get('/auth/status'), 'pass'],
    ['a write to the API', { method: 'POST', url: `${ORIGIN}/v1/windows`, mode: 'cors' }, 'pass'],
    ['a write to an asset path', { method: 'POST', url: `${ORIGIN}/assets/x.js`, mode: 'cors' }, 'pass'],
    ['the manifest and icons', get('/app/manifest.webmanifest'), 'pass'],
    ['the worker itself', get('/sw.js'), 'pass'],
    ['another origin\'s bundle', get('/assets/App-1a2b3c.js', 'cors', 'https://cdn.example'), 'pass'],
    ['another origin\'s page', get('/', 'navigate', 'https://preview.orchard.example'), 'pass'],
  ] as const)('%s: %s', (_name, request, route) => {
    expect(routeOf(request, ORIGIN)).toBe(route);
  });
});

describe('the static routes, where the browser has them', () => {
  /** The browser's first-match evaluation of the routes, for one request. */
  const routed = (request: ShellRequest) => DIRECT_ROUTES.find(route => 'navigations' in route ? request.mode === 'navigate'
    : (!route.ownOrigin || new URL(request.url).origin === ORIGIN) && new RegExp(`^${route.pathname.replace('*', '.*')}$`).test(new URL(request.url).pathname))?.source ?? 'fetch-event';
  it.each([
    get('/', 'navigate'), get('/?mode=bot', 'navigate'), get('/auth/login', 'navigate'), get('/p/abc/', 'navigate'),
    get('/assets/App-1a2b3c.js'), get('/assets/index-9f8e.css'),
    get('/v1/remote/hosts'), get('/u/alice/v1/windows'), get('/auth/status'), get('/app/icon-192.png'), get('/sw.js'),
    get('/assets/App-1a2b3c.js', 'cors', 'https://cdn.example'),
  ])('send $url ($mode) where the worker would: to it only when it answers', request => {
    expect(routed(request)).toBe(routeOf(request, ORIGIN) === 'pass' ? 'network' : 'fetch-event');
  });
});

/** Cache storage in memory, keyed by URL as the browser's is for GET requests. */
function memoryCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const key = (request: ShellRequest | string) => new URL(typeof request === 'string' ? request : request.url, ORIGIN).href;
  const caches: ShellCaches = {
    async open(name) {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      const cache: ShellCache = {
        async match(request) { return store.get(key(request))?.clone(); },
        async put(request, response) { store.set(key(request), response); },
      };
      return cache;
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  return { caches, stores, kept: (name: string) => [...stores.get(name)?.keys() ?? []].map(url => new URL(url).pathname).sort() };
}

/** A network whose files a test sets, which fails when it is off, and which counts what it was asked. */
function network(files: Record<string, { body: string; type?: string; status?: number }>) {
  const state = { offline: false, asked: [] as string[] };
  const fetch = async (request: ShellRequest | string) => {
    const path = new URL(typeof request === 'string' ? request : request.url, ORIGIN).pathname;
    state.asked.push(path);
    if (state.offline) throw new TypeError('Failed to fetch');
    const file = files[path];
    if (!file) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(file.body, { status: file.status ?? 200, headers: { 'content-type': file.type ?? 'text/javascript' } });
  };
  return { fetch, state };
}

const SHELL: AppShell = { version: 'build-2', files: ['/assets/index-2.js', '/assets/index-2.css', '/assets/App-2.js'] };
const SITE = {
  '/': { body: '<!doctype html><title>Orchard build 2</title>', type: 'text/html; charset=utf-8' },
  '/assets/index-2.js': { body: 'entry 2' }, '/assets/index-2.css': { body: 'css 2', type: 'text/css' }, '/assets/App-2.js': { body: 'app 2' },
  '/assets/Trace-2.js': { body: 'trace 2' },
};
/** A fetch event's context: what the worker keeps alive is awaited before the test looks at the cache. */
function context() {
  const work: Promise<unknown>[] = [];
  return { origin: ORIGIN, waitUntil: (promise: Promise<unknown>) => { work.push(promise); }, settled: () => Promise.all(work) };
}

describe('the worker', () => {
  it('stores the shell at install and, at activation, keeps the build before it and deletes the older ones', async () => {
    const { caches, stores, kept } = memoryCaches();
    await (await caches.open(shellCacheName('build-0'))).put('/', new Response('older'));
    await (await caches.open(shellCacheName('build-1'))).put('/', new Response('old'));
    await (await caches.open('another-app')).put('/', new Response('theirs'));
    const worker = appShellWorker(SHELL, { caches, fetch: network(SITE).fetch });
    await worker.install();
    expect(kept(shellCacheName('build-2'))).toEqual(['/', '/assets/App-2.js', '/assets/index-2.css', '/assets/index-2.js']);
    await worker.activate();
    expect([...stores.keys()].sort()).toEqual(['another-app', shellCacheName('build-1'), shellCacheName('build-2')]);
  });

  it('fails an install whose shell cannot be stored whole, and keeps nothing of it', async () => {
    const { caches, stores } = memoryCaches();
    const { '/assets/App-2.js': _missing, ...partial } = SITE;
    await expect(appShellWorker(SHELL, { caches, fetch: network(partial).fetch }).install()).rejects.toThrow('/assets/App-2.js (404');
    expect(stores.has(shellCacheName('build-2'))).toBe(false);
    // A page that is no HTML, or a bundle of the wrong kind, is no shell either.
    await expect(appShellWorker(SHELL, { caches, fetch: network({ ...SITE, '/': { body: 'Maintenance', type: 'text/plain' } }).fetch }).install()).rejects.toThrow('/ (200 text/plain)');
    await expect(appShellWorker(SHELL, { caches, fetch: network({ ...SITE, '/assets/App-2.js': { body: '<p>portal</p>', type: 'text/plain' } }).fetch }).install()).rejects.toThrow('/assets/App-2.js (200 text/plain)');
    expect(stores.has(shellCacheName('build-2'))).toBe(false);
  });

  it('opens the page from the stored shell without asking the network, offline or on a network that never answers', async () => {
    const { caches } = memoryCaches();
    const site = { ...SITE };
    const net = network(site);
    const worker = appShellWorker(SHELL, { caches, fetch: net.fetch });
    await worker.install();
    net.state.asked = [];
    // A new page is deployed meanwhile: this build keeps serving its own, so its page and its bundles stay together.
    site['/'] = { body: '<!doctype html><title>Orchard build 3</title>', type: 'text/html' };
    for (const mode of ['online', 'offline', 'hung'] as const) {
      const hung = new Promise<Response>(() => undefined);
      const ports = { caches, fetch: mode === 'hung' ? () => hung : net.fetch };
      net.state.offline = mode === 'offline';
      const answer = await appShellWorker(SHELL, ports).respond(get('/?mode=window&window=w1', 'navigate'), context())!;
      expect(answer.status).toBe(200);
      expect(await answer.text()).toContain('build 2');
    }
    expect(net.state.asked).toEqual([]);
    // Its bundles come from the cache too.
    expect(await (await worker.respond(get('/assets/App-2.js'), context()))!.text()).toBe('app 2');
  });

  it('takes the page from the network, and keeps it, only where the install has not stored it', async () => {
    const { caches, kept } = memoryCaches();
    const net = network(SITE);
    const worker = appShellWorker(SHELL, { caches, fetch: net.fetch });
    const first = context();
    expect(await (await worker.respond(get('/', 'navigate'), first)!).text()).toContain('build 2');
    await first.settled();
    expect(kept(shellCacheName('build-2'))).toEqual(['/']);
    net.state.offline = true;
    await expect(appShellWorker({ ...SHELL, version: 'build-9' }, { caches, fetch: net.fetch }).respond(get('/', 'navigate'), context())).rejects.toThrow('Failed to fetch');
  });

  it('answers another navigation from the network, and never keeps it', async () => {
    const { caches, stores } = memoryCaches();
    const net = network({ ...SITE, '/auth/login': { body: '<p>sign in</p>', type: 'text/html' } });
    const worker = appShellWorker(SHELL, { caches, fetch: net.fetch });
    const signIn = context();
    expect(await (await worker.respond(get('/auth/login', 'navigate'), signIn)!).text()).toBe('<p>sign in</p>');
    await signIn.settled();
    expect(stores.size).toBe(0);
  });

  it('keeps neither a redirect nor an error as the shell', async () => {
    const { caches, kept } = memoryCaches();
    const unavailable = context();
    const down = network({ ...SITE, '/': { body: 'Controller assets are unavailable.', type: 'text/plain', status: 503 } });
    expect((await appShellWorker(SHELL, { caches, fetch: down.fetch }).respond(get('/', 'navigate'), unavailable)!).status).toBe(503);
    // A page the network reached through a redirect (a sign-in that came back) is shown, not kept.
    const followed = new Response('<!doctype html><title>after sign-in</title>', { headers: { 'content-type': 'text/html' } });
    Object.defineProperty(followed, 'redirected', { value: true });
    const redirected = context();
    expect(await (await appShellWorker(SHELL, { caches, fetch: async () => followed }).respond(get('/', 'navigate'), redirected)!).text()).toContain('after sign-in');
    await Promise.all([unavailable.settled(), redirected.settled()]);
    expect(kept(shellCacheName('build-2'))).toEqual([]);
  });

  it('answers a bundle from the cache first and fills the cache from the network, but never with an error or an HTML fallback', async () => {
    const { caches, kept } = memoryCaches();
    const net = network({ ...SITE, '/assets/Gone-1.js': { body: '<!doctype html>', type: 'text/html' }, '/assets/Portal-1.js': { body: 'Log in to the Wi-Fi', type: 'text/plain' } });
    const worker = appShellWorker(SHELL, { caches, fetch: net.fetch });
    const first = context();
    expect(await (await worker.respond(get('/assets/Trace-2.js'), first))!.text()).toBe('trace 2');
    await first.settled();
    net.state.asked = [];
    expect(await (await worker.respond(get('/assets/Trace-2.js'), context()))!.text()).toBe('trace 2');
    expect(net.state.asked).toEqual([]);
    // A chunk of an older build is gone: its error reaches the page, so the chunk recovery reloads, and nothing is kept.
    const missing = context();
    expect((await worker.respond(get('/assets/App-1.js'), missing)!).status).toBe(404);
    expect((await worker.respond(get('/assets/Gone-1.js'), missing)!).headers.get('content-type')).toBe('text/html');
    // A script that comes back as something else (a portal's page) is answered once and asked for again next time.
    expect((await worker.respond(get('/assets/Portal-1.js'), missing)!).headers.get('content-type')).toBe('text/plain');
    await missing.settled();
    expect(kept(shellCacheName('build-2'))).toEqual(['/assets/Trace-2.js']);
  });

  it('answers a page still open on the previous build from that build\'s cache, so its chunks survive a deployment', async () => {
    const { caches } = memoryCaches();
    await (await caches.open(shellCacheName('build-1'))).put('/assets/Trace-1.js', new Response('trace 1', { headers: { 'content-type': 'text/javascript' } }));
    const net = network(SITE);
    net.state.offline = true;
    const worker = appShellWorker(SHELL, { caches, fetch: net.fetch });
    expect(await (await worker.respond(get('/assets/Trace-1.js'), context())!).text()).toBe('trace 1');
  });

  it('fails a bundle the network cannot give and the cache does not have, as the page would without the worker', async () => {
    const { caches } = memoryCaches();
    const net = network(SITE);
    net.state.offline = true;
    await expect(appShellWorker(SHELL, { caches, fetch: net.fetch }).respond(get('/assets/App-2.js'), context())).rejects.toThrow('Failed to fetch');
  });

  it('leaves the API and every other request to the browser, and never keeps them', async () => {
    const { caches, stores } = memoryCaches();
    const net = network(SITE);
    const worker = appShellWorker(SHELL, { caches, fetch: net.fetch });
    for (const request of [get('/v1/remote/hosts'), get('/auth/status'), { method: 'POST', url: `${ORIGIN}/v1/windows`, mode: 'cors' }, get('/app/icon-192.png')]) {
      expect(worker.respond(request, context())).toBeUndefined();
    }
    expect(net.state.asked).toEqual([]);
    expect(stores.size).toBe(0);
  });
});
