import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWriteFile } from '@orchardworks/agent-platform';
import type { SessionReferenceNote } from '@orchardworks/agent-remote-protocol';

/** A session on this Host, by provider and native identity. */
export interface SessionRefTarget { providerId: string; nativeSessionId: string }
/** A reference as sessions and pages see it: the source a session was opened from, or one added later. */
export interface SessionRef extends SessionRefTarget { origin: 'source' | 'added'; title?: string; addedAt?: string }
/** A session that references this one, and how. */
export interface SessionReferrer extends SessionRefTarget { origin: 'source' | 'added'; title?: string }
export interface SessionRefs { revision: number; refs: SessionRef[]; referencedBy: SessionReferrer[] }

interface SavedSource extends SessionRefTarget { addedAt: string; removed?: true }
interface SavedHolder extends SessionRefTarget {
  revision: number;
  refs: Array<SessionRefTarget & { addedAt: string }>;
  source?: SavedSource;
  /** The revision the session's agent was last told about with an input. */
  delivered?: number;
}
interface SavedRefs { version: 1; holders: SavedHolder[] }

/** Sessions whose references are kept; the least recently changed is forgotten first. */
const HOLDER_LIMIT = 4096;
const REF_LIMIT = 32;
const key = (ref: SessionRefTarget) => JSON.stringify([ref.providerId, ref.nativeSessionId]);
const same = (left: SessionRefTarget, right: SessionRefTarget) => key(left) === key(right);
const target = (ref: SessionRefTarget): SessionRefTarget => ({ providerId: ref.providerId, nativeSessionId: ref.nativeSessionId });

/**
 * The sessions each session references, an attribute of every session on this Host: the source it was opened from and
 * sessions added later, with a revision that changes with every change to them. References name sessions; they grant
 * nothing: what a session may read is decided where it reads.
 */
export class SessionRefStore {
  private readonly holders = new Map<string, SavedHolder>();
  private writes: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(private readonly path: string) { this.ready = this.load(); }

  private async load(): Promise<void> {
    let saved: SavedRefs;
    try { saved = JSON.parse(await readFile(this.path, 'utf8')) as SavedRefs; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('Saved session references could not be read.');
    }
    if (saved?.version !== 1 || !Array.isArray(saved.holders)) throw new Error('Saved session references are invalid.');
    for (const holder of saved.holders) {
      if (!validTarget(holder) || !Number.isSafeInteger(holder.revision) || holder.revision < 0 || !Array.isArray(holder.refs)) continue;
      const refs = holder.refs.filter(ref => validTarget(ref) && typeof ref.addedAt === 'string').slice(0, REF_LIMIT)
        .map(ref => ({ ...target(ref), addedAt: ref.addedAt }));
      const source = validTarget(holder.source) && typeof holder.source.addedAt === 'string'
        ? { ...target(holder.source), addedAt: holder.source.addedAt, ...(holder.source.removed === true ? { removed: true as const } : {}) } : undefined;
      const delivered = Number.isSafeInteger(holder.delivered) && holder.delivered! >= 0 ? holder.delivered : undefined;
      this.holders.set(key(holder), { ...target(holder), revision: holder.revision, refs, ...(source ? { source } : {}), ...(delivered !== undefined ? { delivered } : {}) });
    }
  }

  async read(holder: SessionRefTarget): Promise<{ revision: number; refs: Array<SessionRefTarget & { addedAt: string }>; source?: SavedSource; delivered: number }> {
    await this.ready;
    const saved = this.holders.get(key(holder));
    return { revision: saved?.revision ?? 0, refs: saved?.refs.map(ref => ({ ...ref })) ?? [], ...(saved?.source ? { source: { ...saved.source } } : {}), delivered: saved?.delivered ?? 0 };
  }

  /** Adds a reference; false when the holder already has it. */
  async add(holder: SessionRefTarget, ref: SessionRefTarget, now = new Date()): Promise<boolean> {
    await this.ready;
    const saved = this.holder(holder);
    if (saved.refs.some(existing => same(existing, ref))) return false;
    if (saved.refs.length >= REF_LIMIT) throw new SessionRefError('invalid_request', `A session can reference at most ${REF_LIMIT} sessions.`);
    saved.refs.push({ ...target(ref), addedAt: now.toISOString() });
    await this.changed(saved);
    return true;
  }

  /** Removes a reference; false when the holder does not have it. */
  async remove(holder: SessionRefTarget, ref: SessionRefTarget): Promise<boolean> {
    await this.ready;
    const saved = this.holders.get(key(holder));
    if (!saved?.refs.some(existing => same(existing, ref))) return false;
    saved.refs = saved.refs.filter(existing => !same(existing, ref));
    await this.changed(saved);
    return true;
  }

  /**
   * Records the session a holder was opened from. tell: its agent does not know it yet and hears about it with its next
   * input; a source its agent was told about when it was created changes nothing it must be told.
   */
  async setSource(holder: SessionRefTarget, source: SessionRefTarget, options: { tell: boolean; removed?: boolean; now?: Date }): Promise<void> {
    await this.ready;
    const saved = this.holder(holder);
    saved.source = { ...target(source), addedAt: (options.now ?? new Date()).toISOString(), ...(options.removed ? { removed: true as const } : {}) };
    if (options.tell) await this.changed(saved);
    else await this.write();
  }

  /** Removes or restores the source; false when it already is, or there is none. */
  async setSourceRemoved(holder: SessionRefTarget, removed: boolean): Promise<boolean> {
    await this.ready;
    const saved = this.holders.get(key(holder));
    if (!saved?.source || (saved.source.removed === true) === removed) return false;
    if (removed) saved.source.removed = true; else delete saved.source.removed;
    await this.changed(saved);
    return true;
  }

  /** Remembers the revision an input told the holder's agent about. */
  async markDelivered(holder: SessionRefTarget, revision: number): Promise<void> {
    await this.ready;
    const saved = this.holders.get(key(holder));
    if (!saved || (saved.delivered ?? 0) >= revision) return;
    saved.delivered = revision;
    await this.write();
  }

  /** The sessions that reference a session, by their source or an added reference. */
  async referencedBy(ref: SessionRefTarget): Promise<SessionReferrer[]> {
    await this.ready;
    const result: SessionReferrer[] = [];
    for (const saved of this.holders.values()) {
      if (saved.source && !saved.source.removed && same(saved.source, ref)) result.push({ ...target(saved), origin: 'source' });
      else if (saved.refs.some(existing => same(existing, ref))) result.push({ ...target(saved), origin: 'added' });
    }
    return result;
  }

  private holder(ref: SessionRefTarget): SavedHolder {
    let saved = this.holders.get(key(ref));
    if (!saved) this.holders.set(key(ref), saved = { ...target(ref), revision: 0, refs: [] });
    return saved;
  }

  private changed(saved: SavedHolder): Promise<void> {
    saved.revision += 1;
    this.holders.delete(key(saved));
    this.holders.set(key(saved), saved);
    return this.write();
  }

  private write(): Promise<void> {
    while (this.holders.size > HOLDER_LIMIT) this.holders.delete(this.holders.keys().next().value!);
    const document: SavedRefs = { version: 1, holders: [...this.holders.values()] };
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await atomicWriteFile(this.path, JSON.stringify(document));
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}

export class SessionRefError extends Error {
  constructor(readonly code: 'invalid_request' | 'session_not_found' | 'unsupported_configuration', message: string) { super(message); }
}

/** What reading and changing references needs from the Host. */
export interface SessionRefContext {
  store: SessionRefStore;
  hostId(): Promise<string | undefined>;
  /** The source a session was given before references were kept here: its provider's source grant. */
  grantedSource?(holder: SessionRefTarget): Promise<{ sourceNativeSessionId: string; removed: boolean } | undefined>;
  /** Makes the provider's source tool refuse or read again; a session without a grant has nothing to change. */
  setGrantRemoved?(holder: SessionRefTarget, removed: boolean): Promise<void>;
  /** The title of a session on this Host, empty when it has none; undefined when the Host does not list it. */
  title(target: SessionRefTarget): Promise<string | undefined>;
}

/** Sessions whose provider grant was already looked at, so listing many sessions does not read every grant again. */
const adopted = new WeakMap<SessionRefStore, Set<string>>();
async function savedRefs(holder: SessionRefTarget, context: SessionRefContext) {
  const checked = adopted.get(context.store) ?? new Set<string>();
  adopted.set(context.store, checked);
  let saved = await context.store.read(holder);
  if (!saved.source && context.grantedSource && !checked.has(key(holder))) {
    checked.add(key(holder));
    const grant = await context.grantedSource(holder).catch(() => undefined);
    // A session created as a Side was told about its source when it was created.
    if (grant) {
      await context.store.setSource(holder, { providerId: holder.providerId, nativeSessionId: grant.sourceNativeSessionId }, { tell: false, removed: grant.removed });
      saved = await context.store.read(holder);
    }
  }
  return saved;
}

export async function describeSessionRefs(holder: SessionRefTarget, context: SessionRefContext): Promise<SessionRefs> {
  const saved = await savedRefs(holder, context);
  const refs: SessionRef[] = [];
  if (saved.source && !saved.source.removed) refs.push({ ...target(saved.source), origin: 'source' });
  for (const ref of saved.refs) if (!refs.some(existing => same(existing, ref))) refs.push({ ...ref, origin: 'added' });
  const titled = async <T extends SessionRefTarget>(ref: T): Promise<T & { title?: string }> => {
    const title = await context.title(ref).catch(() => undefined);
    return title ? { ...ref, title } : ref;
  };
  const referrers = (await context.store.referencedBy(holder)).filter(ref => !same(ref, holder));
  return { revision: saved.revision, refs: await Promise.all(refs.map(titled)), referencedBy: await Promise.all(referrers.map(titled)) };
}

/** Adds or removes one reference. The source a session was opened from is removed and restored like any other. */
export async function changeSessionRef(holder: SessionRefTarget, action: 'add' | 'remove', ref: SessionRefTarget, context: SessionRefContext): Promise<SessionRefs> {
  if (same(holder, ref)) throw new SessionRefError('invalid_request', 'A session cannot reference itself.');
  const saved = await savedRefs(holder, context);
  const isSource = !!saved.source && same(saved.source, ref);
  if (action === 'add') {
    if (isSource) {
      if (await context.store.setSourceRemoved(holder, false)) await context.setGrantRemoved?.(holder, false);
    } else {
      if (await context.title(ref).catch(() => undefined) === undefined) throw new SessionRefError('session_not_found', 'No such session on this Host.');
      await context.store.add(holder, ref);
    }
  } else if (isSource) {
    if (await context.store.setSourceRemoved(holder, true)) await context.setGrantRemoved?.(holder, true);
    await context.store.remove(holder, ref);
  } else await context.store.remove(holder, ref);
  return describeSessionRefs(holder, context);
}

/** The note the holder's next input carries when its references changed since its agent was last told. */
export async function pendingReferenceNote(holder: SessionRefTarget, context: SessionRefContext): Promise<SessionReferenceNote | undefined> {
  const saved = await savedRefs(holder, context);
  if (saved.revision <= saved.delivered) return undefined;
  const described = await describeSessionRefs(holder, context), host = await context.hostId() ?? 'local';
  return { revision: described.revision, references: described.refs.map(ref => ({ address: `${host}/${ref.providerId}/${ref.nativeSessionId}`, ...(ref.title ? { title: ref.title } : {}), origin: ref.origin })) };
}

export function validTarget(value: unknown): value is SessionRefTarget {
  const ref = value as Partial<SessionRefTarget> | null;
  return typeof ref?.providerId === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(ref.providerId)
    && typeof ref.nativeSessionId === 'string' && !!ref.nativeSessionId && ref.nativeSessionId.length <= 512;
}
