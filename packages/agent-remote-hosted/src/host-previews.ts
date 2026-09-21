import { createPreviewRelayBridge, createTunnelPeer, type PreviewSnapshot, type PreviewRegistration, type TunnelSocket } from '@orchardworks/agent-remote-tunnel';

import { createPreviewActivity } from './preview-activity.js';
import { PreviewNameError, previewNameId, previewTargetKey, reconcilePreviewNames, type PreviewNames } from './preview-names.js';

export interface HostPreviewState extends PreviewNames { hostId: string; snapshot: PreviewSnapshot; pendingRemovals: string[] }
interface Options {
  initial?: HostPreviewState[];
  save(state: HostPreviewState[], publish: () => void): Promise<void>;
  remove(hostId: string, id: string): Promise<void>;
  renew?(hostId: string, id: string): Promise<{ expiresAt: number }>;
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
  const activity = createPreviewActivity({
    available: (hostId, id) => !closed && !!lookup(hostId, id) && peers.has(hostId),
    renew: (hostId, id) => options.renew ? options.renew(hostId, id) : Promise.reject(new Error('Preview renewal unavailable.')),
  });
  function disconnect(hostId: string) {
    activity.forget(hostId);
    generations.set(hostId, (generations.get(hostId) ?? 0) + 1);
    reconciled.delete(hostId); bridges.get(hostId)?.close(); peers.get(hostId)?.close(1012, 'Controller disconnected'); peers.delete(hostId);
    bridges.delete(hostId);
  }
  return {
    snapshot: () => structuredClone(records),
    nameId: (hostId: string, id: string) => previewNameId(record(hostId), id),
    async pinName(hostId: string, id: string, pinned: boolean) {
      await mutate(draft => {
        const current = draft.find(value => value.hostId === hostId);
        const registration = current?.snapshot.registrations.find(value => value.id === id);
        if (!current || !registration || registration.status !== 'active' || registration.expiresAt <= Date.now() || current.pendingRemovals.includes(id))
          throw new PreviewNameError(409, 'This preview is no longer active. Refresh the list.');
        const target = previewTargetKey(registration.target);
        const pins = current.pins ?? [];
        if (!pinned) { current.pins = pins.filter(value => value.target !== target); return; }
        const nameId = previewNameId(current, id);
        const existing = pins.find(value => value.target === target);
        if (existing && existing.nameId !== nameId) throw new PreviewNameError(409, 'This local origin already has a pinned tunnel name. Unpin it before choosing another.');
        if (existing) return false;
        if (pins.length >= 256) throw new PreviewNameError(409, 'This Host has reached its pinned tunnel name limit. Unpin an unused name first.');
        current.pins = [...pins, { target, nameId }];
      });
    },
    list(hostId: string) {
      const current = record(hostId);
      return { ...(current?.snapshot ?? { epoch: '', revision: 0, registrations: [] }), registrations: (current?.snapshot.registrations ?? []).map(value => ({ ...value,
        tunnelNamePinned: current?.pins?.some(pin => pin.target === previewTargetKey(value.target) && pin.nameId === previewNameId(current, value.id)) ?? false,
        availability: reconciled.has(hostId) && peers.has(hostId) ? 'online' as const : 'controller_offline' as const,
        ...(current?.pendingRemovals.includes(value.id) ? { pendingUnregister: true } : {}),
      })) };
    },
    lookup,
    activity: activity.record,
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
        const next = current ?? { hostId, snapshot, pendingRemovals: [] };
        reconcilePreviewNames(next, snapshot);
        next.snapshot = snapshot;
        if (!current) draft.push(next);
      });
      if (generation !== (generations.get(hostId) ?? 0)) return;
      if (prior?.epoch === snapshot.epoch && prior.revision > snapshot.revision) return;
      if (accepted) {
        for (const value of snapshot.registrations) if (value.status !== 'active') { activity.forget(hostId, value.id); peers.get(hostId)?.cancelPreview(value.id); }
        for (const value of prior?.registrations ?? []) if (!snapshot.registrations.some(next => next.id === value.id)) { activity.forget(hostId, value.id); peers.get(hostId)?.cancelPreview(value.id); }
      }
      // Pending removals block lookup throughout reconciliation, including failed retries.
      for (const id of [...(record(hostId)?.pendingRemovals ?? [])]) {
        const value = currentSnapshot.registrations.find(value => value.id === id);
        if (value && value.status !== 'unregistered') {
          try { await options.remove(hostId, id); } catch { continue; }
          continue;
        }
        await mutate(draft => { const current = draft.find(value => value.hostId === hostId)!; current.pendingRemovals = current.pendingRemovals.filter(value => value !== id); });
      }
      if (!closed && generation === (generations.get(hostId) ?? 0)) reconciled.add(hostId);
    },
    async unregister(hostId: string, id: string) {
      activity.forget(hostId, id);
      if (!record(hostId)?.snapshot.registrations.some(value => value.id === id)) throw new Error('Preview is unavailable.');
      await mutate(draft => { const current = draft.find(value => value.hostId === hostId)!; if (!current.pendingRemovals.includes(id)) current.pendingRemovals.push(id); });
      peers.get(hostId)?.cancelPreview(id);
      try { await options.remove(hostId, id); } catch { /* Durable pending removal is delivered on reconciliation. */ }
    },
    attach(hostId: string, socket: TunnelSocket) {
      bridges.get(hostId)?.close();
      peers.get(hostId)?.close(1012, 'Tunnel replaced');
      const peer = createTunnelPeer(socket, {});
      peers.set(hostId, peer);
      const bridge = createPreviewRelayBridge(peer, id => lookup(hostId, id));
      bridges.set(hostId, bridge);
      socket.onClose(() => { bridge.close(); if (peers.get(hostId) === peer) { peers.delete(hostId); bridges.delete(hostId); } });
    },
    bridge(hostId: string) { return reconciled.has(hostId) ? bridges.get(hostId) : undefined; },
    invalidate(hostId: string) { activity.forget(hostId); generations.set(hostId, (generations.get(hostId) ?? 0) + 1); reconciled.delete(hostId); },
    forget(hostId: string) { records = records.filter(value => value.hostId !== hostId); disconnect(hostId); },
    disconnect,
    close() { closed = true; activity.close(); for (const hostId of peers.keys()) disconnect(hostId); },
  };
}
