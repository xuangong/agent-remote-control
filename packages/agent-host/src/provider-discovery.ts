import { prepareSharedCodex } from './codex-shared-startup.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '@orchardworks/agent-platform';
import { isHostProviderChange, type HostProviderState, type HostProviderSettings } from '@orchardworks/agent-remote-protocol';
import { createHostRegistrations, hostProviderIds } from './registrations.js';
import type { AgentHostProviderRegistration } from './host.js';
import type { AgentRemoteHttpResult, RemoteHostControlRequest } from '@orchardworks/agent-remote-relay';

const names: Record<string, string> = { codex: 'Codex', claude: 'Claude Code', copilot: 'GitHub Copilot', opencode: 'OpenCode' };
export interface HostProviderDiscovery {
  readonly registrations: AgentHostProviderRegistration[];
  enabled(providerId: string): boolean;
  snapshot(): HostProviderSettings;
  refresh(): Promise<void>;
  subscribe(listener: () => void): () => void;
  onRegistration(listener: (registration: AgentHostProviderRegistration) => void): void;
  control(request: RemoteHostControlRequest): Promise<AgentRemoteHttpResult>;
  stop(): Promise<void>;
}
export async function createHostProviderDiscovery(options: {
  stateDir: string; env: NodeJS.ProcessEnv; onDiagnostic?: (line: string) => void;
  create?: (providerId: string) => Promise<AgentHostProviderRegistration>;
}): Promise<HostProviderDiscovery> {
  const path = join(options.stateDir, 'provider-settings.json');
  let disabled: string[] = [];
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(saved.disabled) || saved.disabled.length > 64 || saved.disabled.some((id: unknown) => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id))) throw new Error('Invalid provider settings.');
    disabled = [...new Set<string>(saved.disabled)];
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read Host provider preferences; refusing to discard disabled providers.'); }
  const registrations: AgentHostProviderRegistration[] = [];
  const listeners = new Set<() => void>();
  let register: ((registration: AgentHostProviderRegistration) => void) | undefined;
  const states = new Map<string, HostProviderState>();
  let revision = randomUUID(), closed = false;
  let pending: Promise<unknown> = Promise.resolve();
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = pending.then(() => { if (closed) throw new Error('Provider discovery is closed.'); return work(); });
    pending = result.catch(() => undefined); return result;
  }
  const create = options.create ?? (async providerId => {
    if (providerId === 'codex') await prepareSharedCodex(options.stateDir, options.env);
    return (await createHostRegistrations({ ...options.env, AGENT_HOST_PROVIDERS: providerId, AGENT_HOST_PROVIDER_DISCOVERY: '1' }, options.onDiagnostic))[0]!;
  });
  function publish() { revision = randomUUID(); for (const listener of listeners) listener(); }
  async function scan() {
    const before = JSON.stringify(hostProviderIds.map(id => states.get(id)));
    await Promise.all(hostProviderIds.map(async providerId => {
      const existing = registrations.find(item => item.directory.providerId === providerId);
      if (disabled.includes(providerId)) { states.set(providerId, { providerId, displayName: names[providerId]!, state: 'disabled' }); return; }
      if (existing) { states.set(providerId, { providerId, displayName: names[providerId]!, state: 'enabled' }); return; }
      try {
        const value = await create(providerId);
        if (closed) { await value.directory.close(); return; }
        try { register?.(value); } catch (error) { await value.directory.close(); throw error; }
        registrations.push(value);
        states.set(providerId, { providerId, displayName: names[providerId]!, state: 'enabled' });
        options.onDiagnostic?.(JSON.stringify({ event: 'provider_discovered', providerId, outcome: 'available' }));
      } catch {
        const changed = states.get(providerId)?.state !== 'unavailable';
        states.set(providerId, { providerId, displayName: names[providerId]!, state: 'unavailable', reason: 'No supported installation or reachable service was found. Check the native version and Controller environment.' });
        if (changed) options.onDiagnostic?.(JSON.stringify({ event: 'provider_discovered', providerId, outcome: 'unavailable' }));
      }
    }));
    registrations.sort((left, right) => hostProviderIds.indexOf(left.directory.providerId as typeof hostProviderIds[number]) - hostProviderIds.indexOf(right.directory.providerId as typeof hostProviderIds[number]));
    if (before !== JSON.stringify(hostProviderIds.map(id => states.get(id)))) publish();
  }
  const snapshot = (): HostProviderSettings => ({ revision, providers: hostProviderIds.map(id => states.get(id)!) });
  await scan();
  return {
    registrations, snapshot,
    enabled: id => !disabled.includes(id) && registrations.some(item => item.directory.providerId === id),
    refresh: () => serialize(scan),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onRegistration(listener) { register = listener; },
    async control(request) {
      const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });
      if (request.method === 'GET') return json(200, snapshot());
      let input: unknown; try { input = JSON.parse(request.body ?? ''); } catch { return json(400, { error: 'Invalid provider settings.' }); }
      if (!isHostProviderChange(input)) return json(400, { error: 'Invalid provider settings.' });
      const change = input;
      return serialize(async () => {
        if ('refresh' in change) { await scan(); return json(200, snapshot()); }
        if (!hostProviderIds.some(id => id === change.providerId)) return json(400, { error: 'Unknown provider.' });
        if (change.revision !== revision) return json(409, { error: 'Provider settings changed. Refresh before trying again.' });
        const next = change.enabled ? disabled.filter(id => id !== change.providerId) : [...new Set([...disabled, change.providerId])];
        await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
        await atomicWriteFile(path, JSON.stringify({ disabled: next }) + '\n');
        disabled = next;
        await scan();
        return json(200, snapshot());
      }).catch(() => json(503, { error: 'Could not confirm provider preferences. Refresh before retrying.' }));
    },
    async stop() { closed = true; listeners.clear(); await pending; },
  };
}
