import { CONTROLLER_REPOSITORY, compareControllerVersions, isControllerRelease, isControllerVersion, type ControllerRelease } from '@orchardworks/agent-remote-protocol';
const api = `https://api.github.com/repos/${CONTROLLER_REPOSITORY}/releases`;
export const controllerAssetUrl = (version: string, asset: string) => `https://github.com/${CONTROLLER_REPOSITORY}/releases/download/controller-v${version}/${asset}`;
async function json(fetcher: typeof fetch, url: string): Promise<any> {
  const response = await fetcher(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-remote-controller-updates' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Controller release discovery failed (${response.status}). Retry later.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Controller release response is empty.');
  let text = ''; const decoder = new TextDecoder(); let size = 0;
  try { while (true) { const item = await reader.read(); if (item.done) break;
    size += item.value.byteLength; if (size > 1024 * 1024) { await reader.cancel(); throw new Error('Controller release response is too large.'); }
    text += decoder.decode(item.value, { stream: true });
  } } finally { reader.releaseLock(); }
  return JSON.parse(text + decoder.decode());
}
export function createControllerReleases(fetcher: typeof fetch = fetch, now = Date.now) {
  let cached: { at: number; value: ControllerRelease | null } | undefined;
  let failure: { at: number; error: unknown } | undefined;
  let pending: Promise<ControllerRelease | null> | undefined;
  async function read(entry: any): Promise<ControllerRelease> {
    const version = typeof entry?.tag_name === 'string' ? entry.tag_name.replace(/^controller-v/, '') : '';
    if (!isControllerVersion(version) || entry.tag_name !== `controller-v${version}` || entry.draft !== false || entry.prerelease !== false || !entry.published_at
      || !Array.isArray(entry.assets) || !entry.assets.some((a: any) => a.name === 'controller-release.json')) throw new Error('Controller release is not published or is incomplete.');
    const manifest = await json(fetcher, controllerAssetUrl(version, 'controller-release.json'));
    if (!isControllerRelease(manifest) || manifest.version !== version || !entry.assets.some((a: any) => a.name === manifest.asset)) throw new Error('Controller release manifest does not match its published assets.');
    return manifest;
  }
  return {
    async version(version: string) {
      if (!isControllerVersion(version)) throw new Error('Invalid Controller version.');
      return read(await json(fetcher, `${api}/tags/controller-v${version}`));
    },
    async latest(): Promise<ControllerRelease | null> {
      if (cached && now() - cached.at < 300000) return cached.value;
      if (failure && now() - failure.at < 60000) throw failure.error;
      return pending ??= (async () => {
        const entries = await json(fetcher, `${api}?per_page=30`);
        if (!Array.isArray(entries)) throw new Error('Invalid Controller release catalog.');
        const candidates = entries.filter(e => !e.draft && !e.prerelease && isControllerVersion(e.tag_name?.replace(/^controller-v/, ''))
          && e.tag_name.startsWith('controller-v') && e.assets?.some((a: any) => a.name === 'controller-release.json'))
          .sort((a, b) => compareControllerVersions(b.tag_name.slice(12), a.tag_name.slice(12)));
        const value = candidates.length ? await read(candidates[0]) : null;
        failure = undefined; cached = { at: now(), value }; return value;
      })().catch(error => { failure = { at: now(), error }; throw error; }).finally(() => { pending = undefined; });
    },
  };
}
export const controllerReleases = createControllerReleases();
