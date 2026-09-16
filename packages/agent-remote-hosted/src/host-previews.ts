import { createPreviewRelayBridge, createTunnelPeer, type PreviewSnapshot, type PreviewRegistration, type TunnelSocket } from '@agent-remote-controller/agent-remote-tunnel';

export interface HostPreviewState { hostId: string; snapshot: PreviewSnapshot; pendingRemovals: string[] }
interface Options {
  initial?: HostPreviewState[];
  save(state: HostPreviewState[], publish: () => void): Promise<void>;
  remove(hostId: string, id: string): Promise<void>;
}
export function createHostPreviews(options: Options) {
  let records = structuredClone(options.initial ?? []);
  const reconciled = new Set<string>();
  const generations = new Map<string, number>();
  const peers = new Map<string, ReturnType<typeof createTunnelPeer>>();
  const bridges = new Map<string, ReturnType<typeof createPreviewRelayBridge>>();
  let mutations: Promise<unknown> = Promise.resolve();
  let closed = false;
  function record(hostId: string) { return records.find(value => value.hostId === hostId); }
  function mutate(action: (draft: HostPreviewState[]) => void | false): Promise<void> {
    const result = mutations.then(async () => {
      if (closed) throw new Error('Previews are unavailable.');
      const draft = structuredClone(records); if (action(draft) === false) return;
      await options.save(draft, () => { records = draft; });
    });
    mutations = result.catch(() => undefined); return result;
  }
  function lookup(hostId: string, id: string): PreviewRegistration | undefined {
    const current = record(hostId);
    if (!reconciled.has(hostId) || current?.pendingRemovals.includes(id)) return undefined;
    const value = current?.snapshot.registrations.find(value => value.id === id);
    return value?.status === 'active' && value.expiresAt > Date.now() ? value : undefined;
  }
  function disconnect(hostId: string) {
    generations.set(hostId, (generations.get(hostId) ?? 0) + 1);
    reconciled.delete(hostId); peers.get(hostId)?.close(1012, 'Controller disconnected'); peers.delete(hostId);
    bridges.delete(hostId);
  }
  return {
    snapshot: () => structuredClone(records),
    list(hostId: string) {
      const current = record(hostId);
      return { ...(current?.snapshot ?? { epoch: '', revision: 0, registrations: [] }), registrations: (current?.snapshot.registrations ?? []).map(value => ({ ...value,
        availability: reconciled.has(hostId) && peers.has(hostId) ? 'online' as const : 'controller_offline' as const,
        ...(current?.pendingRemovals.includes(value.id) ? { pendingUnregister: true } : {}),
      })) };
    },
    lookup,
    async update(hostId: string, snapshot: PreviewSnapshot) {
      const generation = generations.get(hostId) ?? 0;
      let prior: PreviewSnapshot | undefined;
      let accepted = false;
      let currentSnapshot = snapshot;
      await mutate(draft => {
        if (generation !== (generations.get(hostId) ?? 0)) return false;
        const current = draft.find(value => value.hostId === hostId);
        prior = current?.snapshot;
        if (prior?.epoch === snapshot.epoch && prior.revision > snapshot.revision) return;
        if (prior?.epoch === snapshot.epoch && prior.revision === snapshot.revision) { currentSnapshot = prior; return; }
        accepted = true;
        if (current) current.snapshot = snapshot;
        else draft.push({ hostId, snapshot, pendingRemovals: [] });
      });
      if (generation !== (generations.get(hostId) ?? 0)) return;
      if (prior?.epoch === snapshot.epoch && prior.revision > snapshot.revision) return;
      if (accepted) {
        for (const value of snapshot.registrations) if (value.status !== 'active') peers.get(hostId)?.cancelPreview(value.id);
        for (const value of prior?.registrations ?? []) if (!snapshot.registrations.some(next => next.id === value.id)) peers.get(hostId)?.cancelPreview(value.id);
      }
      // Pending removals block lookup throughout reconciliation, including failed retries.
      for (const id of [...(record(hostId)?.pendingRemovals ?? [])]) {
        const value = currentSnapshot.registrations.find(value => value.id === id);
        if (value?.status === 'active') {
          try { await options.remove(hostId, id); } catch { continue; }
          continue;
        }
        await mutate(draft => { const current = draft.find(value => value.hostId === hostId)!; current.pendingRemovals = current.pendingRemovals.filter(value => value !== id); });
      }
      if (!closed && generation === (generations.get(hostId) ?? 0)) reconciled.add(hostId);
    },
    async unregister(hostId: string, id: string) {
      if (!record(hostId)?.snapshot.registrations.some(value => value.id === id)) throw new Error('Preview is unavailable.');
      await mutate(draft => { const current = draft.find(value => value.hostId === hostId)!; if (!current.pendingRemovals.includes(id)) current.pendingRemovals.push(id); });
      peers.get(hostId)?.cancelPreview(id);
      try { await options.remove(hostId, id); } catch { /* Durable pending removal is delivered on reconciliation. */ }
    },
    attach(hostId: string, socket: TunnelSocket) {
      peers.get(hostId)?.close(1012, 'Tunnel replaced');
      const peer = createTunnelPeer(socket, {});
      peers.set(hostId, peer);
      bridges.set(hostId, createPreviewRelayBridge(peer, id => lookup(hostId, id)));
      socket.onClose(() => { if (peers.get(hostId) === peer) { peers.delete(hostId); bridges.delete(hostId); } });
    },
    bridge(hostId: string) { return reconciled.has(hostId) ? bridges.get(hostId) : undefined; },
    invalidate(hostId: string) { generations.set(hostId, (generations.get(hostId) ?? 0) + 1); reconciled.delete(hostId); },
    forget(hostId: string) { records = records.filter(value => value.hostId !== hostId); disconnect(hostId); },
    disconnect,
    close() { closed = true; for (const hostId of peers.keys()) disconnect(hostId); },
  };
}
