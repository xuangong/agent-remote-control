import { describe, expect, it } from 'vitest';
import type { Host } from './broker-types.js';
import { createHostPlaces, PLACES_FOLDER_LIMIT, PLACES_HOST_LIMIT, PLACES_WORKSPACE_LIMIT } from './host-places.js';
import { RELAY_SOCKET_OPEN } from './transport.js';

// Hosts and their Controllers are stubs: each answers the paths the real Controller serves.
const host = (id: string, extra: Partial<Host> = {}) => ({ id, name: id.toUpperCase(), providers: [{ providerId: 'claude' }, { providerId: 'codex' }], tasks: 1, hostStatus: true, ready: true,
  socket: { readyState: RELAY_SOCKET_OPEN }, ...extra }) as unknown as Host;
const status = { sampledAt: 1, sessions: { running: 2, waiting: 0, idle: 1, failed: 0 }, cpu: { cores: 8, usage: 0.4 }, memory: { total: 100, used: 60 },
  processes: [{ kind: 'session', label: 'claude', cpu: 0.5, memory: 10 }] };

function stack(hosts: Host[], answers: Record<string, (call: { method: string; body?: any }) => { status: number; value: unknown }> = {}) {
  const calls: string[] = [];
  const rpc = async (target: Host, method: 'GET' | 'POST', path: string, _session?: string, body?: string) => {
    calls.push(`${target.id} ${method} ${path}`);
    const [route] = path.split('?'), answer = answers[`${target.id} ${route}`] ?? answers[route!];
    const result = answer ? answer({ method, ...(body ? { body: JSON.parse(body) } : {}) }) : { status: 404, value: { error: 'unknown' } };
    return { status: result.status, body: JSON.stringify(result.value) };
  };
  return { places: createHostPlaces({ hosts: () => hosts, rpc: rpc as never }), calls };
}
const workspaces = { '/remote/workspaces': () => ({ status: 200, value: { workspaces: [{ id: 'w1', path: '/work' }, { id: 'w2', path: '/code' }] } }),
  '/remote/workspace-folders': () => ({ status: 200, value: { folders: [{ name: 'shop', path: '/work/shop' }, { name: 'docs', path: '/work/docs' }] } }),
  '/remote/host-status': () => ({ status: 200, value: status }) };

describe('list_hosts', () => {
  it('shows each Host with its CLIs, load, running sessions and workspaces with their folders, and none of the process list', async () => {
    const { places } = stack([host('mac')], workspaces);
    expect(await places.list()).toEqual([{ id: 'mac', name: 'MAC', online: true, providers: ['claude', 'codex'], cpu: { usage: 0.4, cores: 8 }, memory: { used: 60, total: 100 }, sessions: 2,
      workspaces: [{ path: '/work', folders: ['/work/shop', '/work/docs'] }, { path: '/code', folders: ['/work/shop', '/work/docs'] }] }]);
  });
  it('lists an offline Host without asking it, leaves out a part the Controller does not answer, and skips Hosts that run no bots', async () => {
    const { places, calls } = stack([host('off', { ready: false }), host('old', { tasks: undefined }), host('quiet')], { '/remote/workspaces': workspaces['/remote/workspaces'] });
    expect(await places.list()).toEqual([
      { id: 'quiet', name: 'QUIET', online: true, providers: ['claude', 'codex'], workspaces: [{ path: '/work', folders: [] }, { path: '/code', folders: [] }] },
      { id: 'off', name: 'OFF', online: false, providers: ['claude', 'codex'] }]);
    expect(calls.some(call => call.startsWith('off ') || call.startsWith('old '))).toBe(false);
  });
  it('is bounded: eight Hosts (online first), five workspaces each, twenty folders each', async () => {
    const many = Array.from({ length: 12 }, (_, index) => host(`h${index}`, index < 4 ? { ready: false } : {}));
    const roots = Array.from({ length: 9 }, (_, index) => ({ id: `w${index}`, path: `/w${index}` })), folders = Array.from({ length: 40 }, (_, index) => ({ name: `f${index}`, path: `/w/f${index}` }));
    const { places } = stack(many, { '/remote/workspaces': () => ({ status: 200, value: { workspaces: roots } }), '/remote/workspace-folders': () => ({ status: 200, value: { folders } }) });
    const listed = await places.list();
    expect(listed).toHaveLength(PLACES_HOST_LIMIT);
    expect(listed.filter(place => place.online)).toHaveLength(PLACES_HOST_LIMIT);
    expect(listed[0]!.workspaces).toHaveLength(PLACES_WORKSPACE_LIMIT);
    expect(listed[0]!.workspaces![0]!.folders).toHaveLength(PLACES_FOLDER_LIMIT);
  });
});

describe('a folder for a bot', () => {
  it('accepts a folder the Controller opens, and says why when it does not', async () => {
    const { places } = stack([host('mac')], { '/remote/workspace-folders': ({ method }) => method === 'GET' ? { status: 403, value: { code: 'folder_unavailable' } } : { status: 200, value: {} } });
    await expect(places.assertFolder('mac', 'claude', '/etc')).rejects.toThrow('does not open /etc');
    await expect(places.assertFolder('nope', 'claude', '/work')).rejects.toThrow('list_hosts');
  });
  it('creates a new folder under the first workspace, or under the one named, and returns the Controller\'s refusal as it is', async () => {
    const created: unknown[] = [];
    const { places } = stack([host('mac'), host('off', { ready: false })], { ...workspaces,
      '/remote/workspace-folders/create': ({ body }) => { created.push(body); return body.name === 'taken' ? { status: 409, value: { message: 'A file or folder with this name already exists. Choose another name.' } } : { status: 201, value: { path: `${body.parentPath}/${body.name}` } }; } });
    expect(await places.createFolder('mac', 'claude', 'shop-api')).toBe('/work/shop-api');
    expect(await places.createFolder('mac', 'claude', 'shop-api', '/code')).toBe('/code/shop-api');
    expect(created).toEqual([{ providerId: 'claude', parentPath: '/work', name: 'shop-api' }, { providerId: 'claude', parentPath: '/code', name: 'shop-api' }]);
    await expect(places.createFolder('mac', 'claude', 'taken')).rejects.toThrow('already exists');
    await expect(places.createFolder('off', 'claude', 'x')).rejects.toThrow('offline');
  });
});
