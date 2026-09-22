import { expect, it } from 'vitest';
import { createControllerReleases } from './controller-releases.js';
const manifest = { protocolVersion: '1.5.0', version: '0.2.0', revision: 'a'.repeat(40), sha256: 'b'.repeat(64), asset: 'orchardworks-agent-remote-controller-0.2.0.tgz', nodeMajor: 22, platforms: ['linux-x64'] };
const entry = { tag_name: 'controller-v0.2.0', draft: false, prerelease: false, published_at: '2026-09-22', assets: [{ name: 'controller-release.json' }, { name: manifest.asset }] };
it('selects published stable versions, uses trusted URLs and caches concurrent discovery', async () => {
  const urls: string[] = [];
  const releases = createControllerReleases((async (url: string) => {
    urls.push(url);
    return Response.json(url.endsWith('controller-release.json') ? manifest : [{ ...entry, tag_name: 'controller-v9.0.0', prerelease: true }, entry]);
  }) as typeof fetch);
  const values = await Promise.all([releases.latest(), releases.latest(), releases.latest()]);
  expect(values).toEqual([manifest, manifest, manifest]);
  await releases.latest(); expect(urls).toHaveLength(2);
  expect(urls[1]).toBe('https://github.com/xuangong/agent-remote-control/releases/download/controller-v0.2.0/controller-release.json');
});
it('rejects draft releases and manifest identity changes', async () => {
  const draft = createControllerReleases((async () => Response.json({ ...entry, draft: true })) as typeof fetch);
  await expect(draft.version('0.2.0')).rejects.toThrow('not published');
  const wrong = createControllerReleases((async (url: string) => Response.json(url.endsWith('controller-release.json') ? { ...manifest, version: '0.3.0' } : entry)) as typeof fetch);
  await expect(wrong.version('0.2.0')).rejects.toThrow('does not match');
  await expect(wrong.version('../../other')).rejects.toThrow('Invalid');
});

const repositoryReleases = 'https://github.com/xuangong/agent-remote-control/releases';
function limitedCatalog(options: { status?: number; location?: string; manifest?: unknown; assetStatus?: number } = {}) {
  const requests: { url: string; method: string; redirect?: RequestRedirect }[] = [];
  const fetcher = (async (input: string, init?: RequestInit) => {
    requests.push({ url: input, method: init?.method ?? 'GET', redirect: init?.redirect });
    if (input.startsWith('https://api.github.com/')) return new Response(null, { status: options.status ?? 403 });
    if (input === `${repositoryReleases}/latest`) return new Response(null, { status: 302, headers: { location: options.location ?? `${repositoryReleases}/tag/controller-v0.2.0` } });
    if (input.endsWith('controller-release.json')) return Response.json(options.manifest ?? manifest);
    if (input.endsWith(manifest.asset) && init?.method === 'HEAD') return new Response(null, { status: options.assetStatus ?? 200 });
    throw new Error(`Unexpected request: ${input}`);
  }) as typeof fetch;
  return { requests, releases: createControllerReleases(fetcher) };
}
it.each([403, 429])('discovers and caches the published stable release when REST returns %s', async status => {
  const { releases, requests } = limitedCatalog({ status });
  expect(await Promise.all([releases.latest(), releases.latest()])).toEqual([manifest, manifest]);
  expect(await releases.latest()).toEqual(manifest);
  expect(requests).toHaveLength(4);
  expect(requests[1]).toEqual({ url: `${repositoryReleases}/latest`, method: 'GET', redirect: 'manual' });
  expect(requests[3]).toEqual({ url: `${repositoryReleases}/download/controller-v0.2.0/${manifest.asset}`, method: 'HEAD', redirect: undefined });
});
it('independently verifies a requested version and never substitutes another release', async () => {
  expect(await limitedCatalog().releases.version('0.2.0')).toEqual(manifest);
  const { releases, requests } = limitedCatalog();
  await expect(releases.version('0.1.0')).rejects.toThrow('Cannot verify');
  expect(requests).toHaveLength(2);
});
it.each([
  'https://example.com/releases/tag/controller-v0.2.0',
  `${repositoryReleases}/tag/controller-v0.2.0-rc.1`,
  `${repositoryReleases}/tag/controller-v0.2.0?source=other`,
  `${repositoryReleases}/tag/web-v0.2.0`,
])('rejects an untrusted or nonstable latest release: %s', async location => {
  const { releases, requests } = limitedCatalog({ location });
  await expect(releases.latest()).rejects.toThrow('Cannot verify');
  expect(requests).toHaveLength(2);
});
it('rejects mismatched manifests and missing published packages during fallback', async () => {
  await expect(limitedCatalog({ manifest: { ...manifest, version: '0.3.0' } }).releases.latest()).rejects.toThrow('does not match');
  await expect(limitedCatalog({ assetStatus: 404 }).releases.latest()).rejects.toThrow('incomplete');
});
it('does not bypass other upstream failures and briefly caches failures', async () => {
  const { releases, requests } = limitedCatalog({ status: 500 });
  await expect(releases.latest()).rejects.toThrow('(500)');
  await expect(releases.latest()).rejects.toThrow('(500)');
  expect(requests).toHaveLength(1);
});
