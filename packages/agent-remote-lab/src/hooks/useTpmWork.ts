import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TpmCreate, TpmList, TpmWork } from '@orchardworks/agent-remote-protocol';
import type { SessionTodoDecision } from '@orchardworks/agent-remote-protocol';
import type { TpmActionInput } from '@orchardworks/agent-remote-web/headless';
import type { OpenedSession } from '../directory-client.js';
import type { SessionEntry } from '../session-tree.js';

export type TpmAction = 'pause' | 'resume' | 'reopen' | 'check' | 'archive' | 'unarchive';
export interface TpmService {
  tpmList(hostId: string): Promise<TpmList>;
  tpmWork(hostId: string, id: string): Promise<TpmWork>;
  tpmCreate(hostId: string, input: TpmCreate): Promise<TpmWork>;
  tpmAction(hostId: string, id: string, input: TpmActionInput): Promise<TpmWork>;
}
export interface TpmHost { id: string; name: string; online: boolean; access?: 'owner' | 'shared' }
export interface TpmItem { key: string; hostId: string; hostName: string; online: boolean; work: TpmWork; unread: boolean }
interface Catalog extends TpmList { error?: string }
export function tpmKey(hostId: string, id: string): string { return JSON.stringify([hostId, id]); }
function meaningful(work: TpmWork): string {
  return JSON.stringify([work.title, work.phase, work.waiting, work.paused, work.archived, work.summary, work.nextAction,
    work.todoRevision ?? work.todo?.revision, work.documentRevision ?? [work.document, work.acceptance, work.evidence], work.health, work.creationStatus,
    work.outbox?.filter(intent => intent.status === 'unknown' || intent.status === 'rejected').map(intent => [intent.id, intent.target, intent.status, intent.error])]);
}
function withTodoDetail(work: TpmWork, detail?: TpmWork): TpmWork {
  if (!work.detailsOmitted || !detail?.todo || work.todoRevision !== detail.todo.revision) return work;
  return { ...work, todo: detail.todo, document: detail.document, acceptance: detail.acceptance };
}
function message(error: unknown): string { return error instanceof Error ? error.message : 'TPM operation failed.'; }
function accessDenied(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'status' in error && [401, 403, 404].includes(Number(error.status));
}

/** Catalog observation stays active independently of floating-view visibility. */
export function useTpmWork(service: TpmService | undefined, hosts: readonly TpmHost[], enabled: boolean,
  attach: (session: SessionEntry) => Promise<OpenedSession>, presentationVisible = true) {
  const hostIdentity = JSON.stringify(hosts);
  const stableHosts = useMemo<TpmHost[]>(() => JSON.parse(hostIdentity), [hostIdentity]);
  const [catalogs, setCatalogs] = useState<Record<string, Catalog>>({});
  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState<Record<string, OpenedSession>>({});
  const [details, setDetails] = useState<Record<string, TpmWork>>({});
  const [detailErrors, setDetailErrors] = useState<Record<string, string | undefined>>({});
  const [detailsLoading, setDetailsLoading] = useState<Record<string, boolean>>({});
  const [attachmentErrors, setAttachmentErrors] = useState<Record<string, string | undefined>>({});
  const [attaching, setAttaching] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string>();
  const [opened, setOpened] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [unread, setUnread] = useState<Record<string, boolean>>({});
  const observed = useRef(new Map<string, string>());
  const serviceScope = useRef(service);
  const sameScope = serviceScope.current === service;
  const permittedHosts = stableHosts.filter(host => host.access !== 'shared');
  const visibleCatalogs = sameScope ? Object.fromEntries(Object.entries(catalogs).filter(([id]) => permittedHosts.some(host => host.id === id))) : {};
  const latest = useRef({ catalogs: visibleCatalogs, sessions, details, hosts: stableHosts, attach, selected, expanded, enabled, presentationVisible, service });
  latest.current = { catalogs: visibleCatalogs, sessions, details, hosts: stableHosts, attach, selected, expanded, enabled, presentationVisible, service };
  const generation = useRef(0);
  const attachmentPromises = useRef(new Map<string, Promise<void>>());
  const detailPromises = useRef(new Map<string, Promise<void>>());
  const creationIntents = useRef(new Map<string, string>());
  const mutation = useRef(false);
  useEffect(() => {
    if (serviceScope.current === service) return;
    serviceScope.current = service;
    generation.current++;
    observed.current.clear(); attachmentPromises.current.clear(); detailPromises.current.clear(); creationIntents.current.clear();
    setCatalogs({}); setSessions({}); setAttachmentErrors({}); setAttaching({}); setSelected(undefined); setOpened([]); setExpanded(false); setUnread({}); setError(undefined);
    setDetails({}); setDetailErrors({}); setDetailsLoading({}); setLoading(false);
  }, [service]);
  useEffect(() => {
    const allowed = new Set(stableHosts.filter(host => host.access !== 'shared').map(host => host.id));
    for (const key of attachmentPromises.current.keys()) if (!allowed.has(JSON.parse(key)[0])) attachmentPromises.current.delete(key);
    for (const key of detailPromises.current.keys()) if (!allowed.has(JSON.parse(key)[0])) detailPromises.current.delete(key);
    setCatalogs(current => Object.fromEntries(Object.entries(current).filter(([hostId]) => allowed.has(hostId))));
    setSessions(current => Object.fromEntries(Object.entries(current).filter(([, session]) => allowed.has(session.hostId ?? 'local'))));
    setDetails(current => Object.fromEntries(Object.entries(current).filter(([key]) => allowed.has(JSON.parse(key)[0]))));
  }, [stableHosts]);
  const authorized = useCallback((hostId: string, requestedService: TpmService | undefined) => latest.current.enabled && latest.current.service === requestedService
    && latest.current.hosts.some(host => host.id === hostId && host.access !== 'shared')
    && !!latest.current.catalogs[hostId]?.supported, []);

  const accept = useCallback((hostId: string, records: TpmWork[]) => {
    const changes: Record<string, boolean> = {};
    for (const work of records) {
      const key = tpmKey(hostId, work.id), fingerprint = meaningful(work), previous = observed.current.get(key);
      if (work.archived || (latest.current.presentationVisible && latest.current.expanded && latest.current.selected === key)) changes[key] = false;
      else if (previous !== undefined && previous !== fingerprint) changes[key] = true;
      observed.current.set(key, fingerprint);
    }
    setUnread(current => {
      return { ...current, ...changes };
    });
  }, []);
  const refresh = useCallback(async () => {
    if (!service || !enabled) return;
    const requestGeneration = generation.current;
    setLoading(true);
    const results = await Promise.allSettled(stableHosts.filter(host => host.online && host.access !== 'shared').map(async host => ({ host, catalog: await service.tpmList(host.id) })));
    if (requestGeneration !== generation.current) return;
    const deniedHosts = stableHosts.filter(host => host.online && host.access !== 'shared').filter((_, index) => {
      const result = results[index]!;
      return result.status === 'rejected' && accessDenied(result.reason);
    }).map(host => host.id);
    if (deniedHosts.length) {
      for (const key of attachmentPromises.current.keys()) if (deniedHosts.includes(JSON.parse(key)[0])) attachmentPromises.current.delete(key);
      for (const key of detailPromises.current.keys()) if (deniedHosts.includes(JSON.parse(key)[0])) detailPromises.current.delete(key);
      setSessions(current => Object.fromEntries(Object.entries(current).filter(([, session]) => !deniedHosts.includes(session.hostId ?? 'local'))));
      setDetails(current => Object.fromEntries(Object.entries(current).filter(([key]) => !deniedHosts.includes(JSON.parse(key)[0]))));
      for (const hostId of deniedHosts) {
        delete latest.current.catalogs[hostId];
        for (const key of observed.current.keys()) if (key.startsWith(JSON.stringify([hostId]).slice(0, -1) + ',')) observed.current.delete(key);
      }
    }
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const current = latest.current.catalogs[result.value.host.id];
      const received = result.value.catalog.works.map(work => {
        const newer = current?.works.find(item => item.id === work.id && item.revision > work.revision);
        return newer ?? work;
      });
      const receivedIds = new Set(received.map(work => work.id));
      result.value.catalog = { ...result.value.catalog, works: [...received, ...(current?.works.filter(work => !receivedIds.has(work.id)) ?? [])] };
    }
    setCatalogs(current => {
      const next = { ...current };
      let index = 0;
      for (const host of stableHosts.filter(host => host.online && host.access !== 'shared')) {
        const result = results[index++]!;
        if (result.status === 'fulfilled') next[host.id] = result.value.catalog;
        else next[host.id] = { ...(accessDenied(result.reason) ? { supported: false, works: [] } : current[host.id] ?? { supported: false, works: [] }), error: message(result.reason) };
      }
      return next;
    });
    for (const result of results) if (result.status === 'fulfilled') accept(result.value.host.id, result.value.catalog.works);
    setLoading(false);
  }, [service, enabled, stableHosts, accept]);
  useEffect(() => {
    generation.current++;
    void refresh();
    if (!enabled || !service) { setLoading(false); return; }
    const timer = window.setInterval(() => void refresh(), 10_000);
    const foreground = () => void refresh();
    window.addEventListener('focus', foreground);
    return () => { generation.current++; window.clearInterval(timer); window.removeEventListener('focus', foreground); };
  }, [refresh, enabled, service]);

  const works = useMemo<TpmItem[]>(() => sameScope ? stableHosts.filter(host => host.access !== 'shared').flatMap(host => (catalogs[host.id]?.works ?? []).map(work => {
    const key = tpmKey(host.id, work.id), detail = details[key];
    return { key, hostId: host.id, hostName: host.name, online: host.online,
      work: withTodoDetail(work.detailsOmitted && detail && detail.revision >= work.revision ? detail : work, detail), unread: !!unread[key] };
  })).sort((a, b) => b.work.updatedAt.localeCompare(a.work.updatedAt) || a.key.localeCompare(b.key)) : [], [stableHosts, catalogs, details, unread, sameScope]);
  const find = useCallback((key: string): TpmItem | undefined => {
    for (const host of latest.current.hosts) {
      if (host.access === 'shared') continue;
      const summary = latest.current.catalogs[host.id]?.works.find(item => tpmKey(host.id, item.id) === key);
      const detail = latest.current.details[key];
      const work = summary ? withTodoDetail(summary.detailsOmitted && detail && detail.revision >= summary.revision ? detail : summary, detail) : undefined;
      if (work) return { key, hostId: host.id, hostName: host.name, online: host.online, work, unread: false };
    }
  }, []);
  const loadDetail = useCallback(async (key: string) => {
    const item = find(key), requestedService = latest.current.service;
    if (!item?.online || !requestedService || !authorized(item.hostId, requestedService) || !item.work.detailsOmitted) return;
    if ((latest.current.details[key]?.revision ?? 0) >= item.work.revision) return;
    const existing = detailPromises.current.get(key);
    if (existing) return existing;
    setDetailsLoading(current => ({ ...current, [key]: true })); setDetailErrors(current => ({ ...current, [key]: undefined }));
    const promise = Promise.resolve().then(async () => {
      try {
        const work = await requestedService.tpmWork(item.hostId, item.work.id);
        if (!authorized(item.hostId, requestedService) || detailPromises.current.get(key) !== promise) return;
        if (work.detailsOmitted || work.revision < (find(key)?.work.revision ?? item.work.revision)) throw new Error('This work changed while its details were loading. Retry to load the current plan.');
        latest.current.details = { ...latest.current.details, [key]: work };
        setDetails(latest.current.details);
      } catch (error) {
        if (!authorized(item.hostId, requestedService) || detailPromises.current.get(key) !== promise) return;
        if (accessDenied(error)) {
          latest.current.catalogs = { ...latest.current.catalogs, [item.hostId]: { supported: false, works: [], error: message(error) } };
          setCatalogs(latest.current.catalogs);
          setSessions(current => Object.fromEntries(Object.entries(current).filter(([, session]) => session.hostId !== item.hostId)));
          setDetails(current => Object.fromEntries(Object.entries(current).filter(([key]) => JSON.parse(key)[0] !== item.hostId)));
        }
        setDetailErrors(current => ({ ...current, [key]: message(error) }));
      } finally {
        if (detailPromises.current.get(key) === promise) {
          detailPromises.current.delete(key); setDetailsLoading(current => ({ ...current, [key]: false }));
        }
      }
    });
    detailPromises.current.set(key, promise);
    return promise;
  }, [find, authorized]);
  const open = useCallback(async (key: string) => {
    const item = find(key);
    if (!item) return;
    const requestedService = latest.current.service;
    setSelected(key); setExpanded(true); setOpened(current => current.includes(key) ? current : [...current, key]);
    setUnread(current => ({ ...current, [key]: false }));
    await loadDetail(key);
    if (!authorized(item.hostId, requestedService)) return;
    const currentItem = find(key), currentWork = currentItem?.work;
    if (currentWork?.detailsOmitted && (latest.current.details[key]?.revision ?? 0) < currentWork.revision) return;
    if (latest.current.sessions[key] || !currentWork?.tpmNativeSessionId || !currentItem?.online || !latest.current.enabled) return;
    const existing = attachmentPromises.current.get(key);
    if (existing) return existing;
    setAttaching(current => ({ ...current, [key]: true })); setAttachmentErrors(current => ({ ...current, [key]: undefined }));
    const promise = Promise.resolve().then(async () => {
      try {
        if (!authorized(item.hostId, requestedService)) return;
        const session = await latest.current.attach({ hostId: item.hostId, providerId: currentWork.providerId, nativeSessionId: currentWork.tpmNativeSessionId!, title: currentWork.title });
        if (authorized(item.hostId, requestedService) && attachmentPromises.current.get(key) === promise) setSessions(current => ({ ...current, [key]: session }));
      } catch (error) { if (authorized(item.hostId, requestedService) && attachmentPromises.current.get(key) === promise) setAttachmentErrors(current => ({ ...current, [key]: message(error) })); }
      finally {
        if (attachmentPromises.current.get(key) === promise) {
          attachmentPromises.current.delete(key); setAttaching(current => ({ ...current, [key]: false }));
        }
      }
    });
    attachmentPromises.current.set(key, promise);
    return promise;
  }, [find, authorized, loadDetail]);
  useEffect(() => {
    for (const key of opened) if (!detailErrors[key] && works.find(item => item.key === key)?.work.detailsOmitted) void loadDetail(key);
  }, [opened, works, detailErrors, loadDetail]);
  useEffect(() => {
    if (presentationVisible && expanded && selected) setUnread(current => current[selected] ? { ...current, [selected]: false } : current);
  }, [presentationVisible, expanded, selected]);
  const selectedWork = works.find(item => item.key === selected);
  useEffect(() => {
    if (presentationVisible && expanded && selected && selectedWork?.online && selectedWork.work.tpmNativeSessionId && !sessions[selected] && !attachmentErrors[selected] && !detailErrors[selected]) void open(selected);
  }, [presentationVisible, expanded, selected, selectedWork?.online, selectedWork?.work.tpmNativeSessionId, sessions, attachmentErrors, detailErrors, open]);

  const update = useCallback((hostId: string, work: TpmWork) => {
    const current = latest.current.catalogs[hostId] ?? { supported: true, works: [] };
    const catalog = { ...current, works: [work, ...current.works.filter(item => item.id !== work.id)] };
    latest.current.catalogs = { ...latest.current.catalogs, [hostId]: catalog };
    setCatalogs(latest.current.catalogs);
    if (!work.detailsOmitted) {
      latest.current.details = { ...latest.current.details, [tpmKey(hostId, work.id)]: work };
      setDetails(latest.current.details);
    }
    accept(hostId, [work]);
  }, [accept]);
  const canCreate = useCallback((main?: SessionEntry) => {
    if (!main || !service || !enabled) return false;
    const hostId = main.hostId ?? 'local';
    const host = latest.current.hosts.find(host => host.id === hostId);
    const catalog = latest.current.catalogs[hostId];
    return !!host?.online && host.access !== 'shared' && !!catalog?.supported && !catalog.error && !!catalog.supportedProviders?.includes(main.providerId);
  }, [service, enabled]);
  const create = useCallback(async (main: SessionEntry, title?: string, requirement?: string) => {
    if (!canCreate(main) || !service) throw new Error('TPM creation is unavailable for this session.');
    if (mutation.current) throw new Error('Wait for the current TPM operation.');
    mutation.current = true; setBusy('create'); setError(undefined);
    try {
      const hostId = main.hostId ?? 'local';
      const intent = JSON.stringify([hostId, main.providerId, main.nativeSessionId, title?.trim(), requirement?.trim()]);
      const operationId = creationIntents.current.get(intent) ?? crypto.randomUUID();
      creationIntents.current.set(intent, operationId);
      const work = await service.tpmCreate(hostId, { providerId: main.providerId, mainNativeSessionId: main.nativeSessionId, ...(title?.trim() ? { title: title.trim() } : {}), ...(requirement?.trim() ? { requirement: requirement.trim() } : {}), operationId });
      if (!authorized(hostId, service)) throw new Error('Workspace access changed before the TPM result arrived.');
      creationIntents.current.delete(intent);
      update(hostId, work);
      await open(tpmKey(hostId, work.id));
      return work;
    } catch (error) { if (latest.current.service === service) setError(message(error)); throw error; }
    finally { mutation.current = false; setBusy(undefined); }
  }, [canCreate, service, update, open, authorized]);
  const mutate = useCallback(async (key: string, input: { action: TpmAction } | { action: 'rename'; title: string } | { action: 'confirm_todo'; confirmation: SessionTodoDecision } | { action: 'resolve'; intentId: string; resolution: 'accepted' | 'rejected'; nativeSessionId?: string }) => {
    const item = find(key);
    if (!service || !enabled || !item?.online) throw new Error('The TPM Controller is unavailable.');
    if (mutation.current) throw new Error('Wait for the current TPM operation.');
    mutation.current = true; setBusy(key); setError(undefined);
    try {
      const work = await service.tpmAction(item.hostId, item.work.id, { ...input, revision: item.work.revision, operationId: crypto.randomUUID() });
      if (!authorized(item.hostId, service)) throw new Error('Workspace access changed before the TPM result arrived.');
      update(item.hostId, work);
      return work;
    } catch (error) {
      if (latest.current.service === service) { setError(message(error)); void refresh(); }
      throw error;
    } finally { mutation.current = false; setBusy(undefined); }
  }, [service, enabled, find, update, refresh, authorized]);
  const rename = useCallback((key: string, title: string) => mutate(key, { action: 'rename', title: title.trim() }), [mutate]);
  const action = useCallback((key: string, action: TpmAction) => mutate(key, { action }), [mutate]);
  const resolve = useCallback((key: string, intentId: string, resolution: 'accepted' | 'rejected', nativeSessionId?: string) => mutate(key, { action: 'resolve', intentId, resolution, ...(nativeSessionId ? { nativeSessionId } : {}) }), [mutate]);
  const confirmTodo = useCallback((key: string, confirmation: SessionTodoDecision) => mutate(key, { action: 'confirm_todo', confirmation }), [mutate]);
  const close = useCallback(() => setExpanded(false), []);
  return { works, catalogs: visibleCatalogs, loading, sessions: sameScope ? sessions : {}, attaching, attachmentErrors, detailsLoading, detailErrors, selected, opened: sameScope ? opened : [], expanded, busy, error,
    available: !!service && enabled, canCreate, create, action, rename, resolve, confirmTodo, open, close, refresh };
}
