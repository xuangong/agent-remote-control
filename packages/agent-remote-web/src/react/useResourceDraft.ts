import { useEffect, useRef, useState } from 'react';
import type { ResourceInputCapabilities, ResourceUploadReceipt, MessagePart } from '@orchardworks/agent-remote-protocol';
import type { DraftPart } from './composer-document.js';
import type { ResourceTransferOptions } from '../client/resource-upload.js';
export type UploadResource = (file: Blob, name: string, uploadId: string, options?: ResourceTransferOptions) => Promise<NonNullable<ResourceUploadReceipt['resource']>>;
import { resourceDraftMemory as memory, readResourceDraft as read, writeResourceDraft as write, resourceDraftGeneration, type Entry } from '../resource-drafts.js';
import type { ImageDraftRecipient } from '../image-drafts.js';
export function useResourceDraft({ scope, sessionKey, parts, active, limits, upload, recipient, documentHydrated = true }: { scope?: string; sessionKey: string; parts: readonly DraftPart[]; active: boolean; limits?: ResourceInputCapabilities; upload?: UploadResource; recipient?: ImageDraftRecipient; documentHydrated?: boolean }) {
  const generation = resourceDraftGeneration(scope ?? 'page');
  const key = JSON.stringify([scope ?? 'page', sessionKey]);
  const entries = useRef(new Map<string, Entry>());
  let entry = entries.current.get(key) ?? (scope ? memory.get(key) : undefined);
  if (entry?.generation !== undefined && entry.generation !== generation) entry = undefined;
  if (!entry) { entry = { generation, records: {}, hydrated: !scope, nextLabel: 1, revision: 0 }; if (scope) memory.set(key, entry); }
  entries.current.set(key, entry); const current = entry;
  function trimCache(reserveBytes = 0): number {
    const retained = new Map([...memory, ...entries.current]);
    const size = (value: Entry) => Object.values(value.records).reduce((bytes, record) => bytes + record.file.size, 0);
    let bytes = [...retained.values()].reduce((sum, value) => sum + size(value), 0);
    for (const [candidate, value] of retained) {
      if (candidate === key || retained.size <= 6 && bytes + reserveBytes <= 128 * 1024 * 1024) continue;
      if (!value.persisted || value.saving || value.storageError || value.dirty) continue;
      bytes -= size(value); retained.delete(candidate);
      if (entries.current.get(candidate) === value) entries.current.delete(candidate);
      if (memory.get(candidate) === value) memory.delete(candidate);
    }
    return bytes;
  }
  trimCache();
  const [, refresh] = useState(0); const mounted = useRef(true);
  const latest = useRef({ key, active, upload }); latest.current = { key, active, upload };
  const ids = parts.flatMap(part => part.type === 'resource' ? [part.resourceId] : []);
  function notify() { if (mounted.current && latest.current.key === key && generation === resourceDraftGeneration(scope ?? 'page')) refresh(value => value + 1); }
  function save() {
    current.dirty = true;
    if (!scope || !current.hydrated || generation !== resourceDraftGeneration(scope)) return;
    const operation = (current.saving ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (generation !== resourceDraftGeneration(scope)) throw new Error('Resource storage owner retired.');
      const revision = current.revision;
      const snapshot = { ...current, records: { ...current.records } };
      await write(key, snapshot);
      current.persisted = true;
      if (current.revision === revision) current.dirty = false;
      current.storageError = undefined;
    }).catch(() => { current.dirty = true; current.storageError = 'Resource files are not saved on this device. Keep this page open.'; })
      .finally(() => { if (current.saving === operation) current.saving = undefined; notify(); });
    current.saving = operation;
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (current.hydrated || !scope) return;
    void read(key).then(saved => {
      if (generation !== resourceDraftGeneration(scope)) return;
      if (current.revision === 0) { if (saved) { current.records = saved.records; current.nextLabel = saved.nextLabel; } current.persisted = true; current.dirty = false; }
      for (const record of Object.values(current.records)) { record.status = 'pending'; record.resource = undefined; }
    }).catch(() => { current.storageError = 'Saved resource files could not be restored. Select them again.'; }).finally(() => { current.hydrated = true; notify(); });
  }, [key, generation]);
  useEffect(() => {
    if (!documentHydrated || !current.hydrated) return;
    const removed = Object.keys(current.records).filter(id => !ids.includes(id));
    if (!removed.length) return;
    for (const id of removed) delete current.records[id];
    current.revision++; save(); notify();
  }, [key, generation, documentHydrated, current.hydrated, ids.join(',')]);
  useEffect(() => {
    if (!documentHydrated || !active || !upload || !current.hydrated || recipient && !recipient.isCurrent()) return;
    const abort = new AbortController();
    // Upload ids are resumable; a fresh receipt belongs to this session connection.
    for (const id of ids) { const record = current.records[id]; if (record?.status === 'ready') { record.status = 'pending'; record.resource = undefined; } }
    const run = async () => {
      for (const id of ids) {
        const record = current.records[id]; if (!record || record.status !== 'pending' || abort.signal.aborted) continue;
        record.status = 'uploading'; record.error = undefined; notify();
        try {
          const resource = await upload(record.file, record.name, id, { signal: abort.signal, onProgress: (loaded, total) => { if (!abort.signal.aborted) { record.progress = total ? loaded / total : 1; notify(); } } });
          if (abort.signal.aborted || recipient && !recipient.isCurrent() || generation !== resourceDraftGeneration(scope ?? 'page')) return;
          record.resource = resource; record.status = 'ready'; record.progress = 1;
        } catch (error) { if (abort.signal.aborted || recipient && !recipient.isCurrent() || generation !== resourceDraftGeneration(scope ?? 'page')) return; record.status = 'failed'; record.error = error instanceof Error ? error.message : 'Resource upload failed.'; }
        save(); notify();
      }
    };
    void run();
    return () => { abort.abort(); for (const id of ids) if (current.records[id]?.status === 'uploading') current.records[id]!.status = 'pending'; };
  }, [key, active, Boolean(upload), ids.join(','), current.hydrated, documentHydrated, current.revision, generation, recipient?.identity, recipient?.lifetime]);
  return {
    hydrated: current.hydrated, storageBusy: Boolean(current.saving), storageError: current.storageError,
    items: ids.map(id => ({ id, label: parts.find(part => part.type === 'resource' && part.resourceId === id)?.type === 'resource' ? (parts.find(part => part.type === 'resource' && part.resourceId === id) as Extract<DraftPart, {type:'resource'}>).label : 'Resource', record: current.records[id] })),
    ready: active && (!recipient || recipient.isCurrent()) && generation === resourceDraftGeneration(scope ?? 'page') && current.hydrated && ids.every(id => current.records[id]?.status === 'ready'),
    add(files: readonly File[]): DraftPart[] {
      if (!current.hydrated || !limits) return [];
      if (ids.length + files.length > limits.maxResources) throw new Error(`A message can contain at most ${limits.maxResources} resources.`);
      const result: DraftPart[] = []; let bytes = ids.reduce((sum, id) => sum + (current.records[id]?.file.size ?? 0), 0);
      for (const file of files) {
        if (ids.length + result.length >= limits.maxResources || file.size > limits.maxResourceBytes || bytes + file.size > limits.maxMessageBytes) throw new Error('Resources exceed the limit: 8 files, 50 MiB each, 100 MiB total.');
        bytes += file.size;
      }
      const addedBytes = files.reduce((sum, file) => sum + file.size, 0);
      if (trimCache(addedBytes) + addedBytes > 128 * 1024 * 1024) throw new Error('Unsent resource files fill the local memory budget. Send or remove existing resources before adding more.');
      for (const id of Object.keys(current.records)) if (!ids.includes(id)) delete current.records[id];
      for (const file of files) { const id = crypto.randomUUID(); current.records[id] = { id, file, name: file.name, status: 'pending', progress: 0 }; result.push({ type: 'resource', resourceId: id, label: `resource #${current.nextLabel++}` }); }
      current.revision++; save(); notify(); return result;
    },
    retry(id: string) { const record = current.records[id]; if (record) { record.status = 'pending'; current.revision++; notify(); } },
    reject(content: readonly MessagePart[], message: string) {
      const rejected = new Set(content.flatMap(part => part.type === 'resource' ? [part.resourceId] : []));
      for (const record of Object.values(current.records)) if (record.resource && rejected.has(record.resource.resourceId)) { record.status = 'failed'; record.error = message; record.resource = undefined; }
      save(); notify();
    },
    snapshot(content: readonly MessagePart[]): MessagePart[] { return content.map(part => { if (part.type !== 'resource') return part; const record = current.records[part.resourceId]; if (!active || recipient && !recipient.isCurrent() || generation !== resourceDraftGeneration(scope ?? 'page') || record?.status !== 'ready' || !record.resource) throw new Error(`${part.label} is not ready.`); return { ...part, resourceId: record.resource.resourceId }; }); },
    clear() { current.records = {}; current.revision++; save(); notify(); },
  };
}
