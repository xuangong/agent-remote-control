/**
 * Where a bot can work: the account's Hosts that run bots, what each reports now, and the folders of its workspaces. Everything is
 * read from the Controller when asked and never stored; a Host that does not answer is listed without that part.
 */
import { isHostStatus } from '@orchardworks/agent-remote-protocol';
import type { Host } from './broker-types.js';
import type { HostSession } from './host-session.js';
import { RELAY_SOCKET_OPEN } from './transport.js';

/** The most Hosts, workspaces of a Host, and folders of a workspace a listing holds. */
export const PLACES_HOST_LIMIT = 8;
export const PLACES_WORKSPACE_LIMIT = 5;
export const PLACES_FOLDER_LIMIT = 20;

/** A Host as `list_hosts` shows it. `cpu.usage` is the share of all cores busy; `sessions` those running. */
export interface HostPlace {
  id: string; name: string; online: boolean; providers: string[];
  cpu?: { usage: number; cores: number }; memory?: { used: number; total: number }; sessions?: number;
  /** Each workspace root with the paths of its folders, as the page's folder picker reads them. */
  workspaces?: Array<{ path: string; folders: string[] }>;
}
export interface HostPlaces {
  list(): Promise<HostPlace[]>;
  /** The Host's name, or its id when no Host answers to it. */
  name(hostId: string): string;
  /** Throws, saying why, unless the Host's Controller allows this folder as a working directory. */
  assertFolder(hostId: string, providerId: string, path: string): Promise<void>;
  /** Creates a folder under a workspace of the Host (the first one when `under` is not named) and returns its path; throws with the Controller's refusal. */
  createFolder(hostId: string, providerId: string, name: string, under?: string): Promise<string>;
}
export interface HostPlacesPorts {
  hosts(): readonly Host[];
  rpc: HostSession['rpc'];
}

const online = (host: Host) => host.ready === true && host.socket?.readyState === RELAY_SOCKET_OPEN;
const runsBots = (host: Host) => host.tasks === 1 && !host.legacyDsh;

export function createHostPlaces(ports: HostPlacesPorts): HostPlaces {
  const find = (hostId: string): Host => {
    const host = ports.hosts().find(item => item.id === hostId && runsBots(item));
    if (!host) throw new Error('No Host of this account answers to that id. List them with list_hosts.');
    if (!online(host)) throw new Error(`Host "${host.name}" is offline.`);
    return host;
  };
  const ask = async (host: Host, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; value: any }> => {
    const result = await ports.rpc(host, method, path, undefined, body === undefined ? undefined : JSON.stringify(body));
    let value: unknown; try { value = JSON.parse(result.body); } catch { value = undefined; }
    return { status: result.status, value };
  };
  const read = async <T>(work: () => Promise<T>): Promise<T | undefined> => { try { return await work(); } catch { return undefined; } };
  const query = (providerId: string, path?: string) => new URLSearchParams({ providerId, ...(path ? { path } : {}) }).toString();
  const workspacesOf = async (host: Host, providerId: string): Promise<string[]> => {
    const answer = await ask(host, 'GET', `/remote/workspaces?${query(providerId)}`);
    if (answer.status !== 200 || !Array.isArray(answer.value?.workspaces)) throw new Error('The Host did not list its workspaces.');
    return answer.value.workspaces.flatMap((workspace: { path?: unknown }) => typeof workspace.path === 'string' ? [workspace.path] : []);
  };
  async function describe(host: Host): Promise<HostPlace> {
    const providers = host.providers.map(provider => provider.providerId), place: HostPlace = { id: host.id, name: host.name, online: online(host), providers };
    if (!place.online) return place;
    const [status, roots] = await Promise.all([
      host.hostStatus ? read(async () => { const answer = await ask(host, 'GET', '/remote/host-status'); return isHostStatus(answer.value) ? answer.value : undefined; }) : undefined,
      read(async () => (await Promise.all(providers.map(providerId => read(() => workspacesOf(host, providerId)).then(paths => (paths ?? []).map(path => ({ providerId, path })))))).flat()),
    ]);
    if (status) {
      if (status.cpu) place.cpu = { usage: status.cpu.usage, cores: status.cpu.cores };
      if (status.memory) place.memory = { used: status.memory.used, total: status.memory.total };
      place.sessions = status.sessions.running;
    }
    const unique = [...new Map((roots ?? []).map(root => [root.path, root])).values()].slice(0, PLACES_WORKSPACE_LIMIT);
    if (unique.length) place.workspaces = await Promise.all(unique.map(async ({ providerId, path }) => {
      const folders = await read(async () => { const answer = await ask(host, 'GET', `/remote/workspace-folders?${query(providerId, path)}`); return answer.status === 200 ? answer.value.folders as Array<{ path: string }> : []; });
      return { path, folders: (folders ?? []).slice(0, PLACES_FOLDER_LIMIT).map(folder => folder.path) };
    }));
    return place;
  }
  return {
    name: hostId => ports.hosts().find(item => item.id === hostId)?.name ?? hostId,
    async list() {
      const hosts = ports.hosts().filter(runsBots).sort((a, b) => Number(online(b)) - Number(online(a))).slice(0, PLACES_HOST_LIMIT);
      return Promise.all(hosts.map(describe));
    },
    async assertFolder(hostId, providerId, path) {
      const host = find(hostId), answer = await ask(host, 'GET', `/remote/workspace-folders?${query(providerId, path)}`);
      if (answer.status !== 200) throw new Error(`Host "${host.name}" does not open ${path}: it is not a folder of its workspaces. Choose one from list_hosts or create a new one with new_folder.`);
    },
    async createFolder(hostId, providerId, name, under) {
      const host = find(hostId), parent = under ?? (await workspacesOf(host, providerId))[0];
      if (!parent) throw new Error(`Host "${host.name}" has no workspace to create a folder under.`);
      const answer = await ask(host, 'POST', '/remote/workspace-folders/create', { providerId, parentPath: parent, name });
      if (answer.status !== 201 || typeof answer.value?.path !== 'string') throw new Error(`Host "${host.name}" did not create ${name} under ${parent}: ${[answer.value?.message, answer.value?.error].find(text => typeof text === 'string') ?? 'refused'}`);
      return answer.value.path;
    },
  };
}
