import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWriteFile } from '@orchardworks/agent-platform';

/** A session on this Host, by provider and native identity. */
export interface SessionRefTarget { providerId: string; nativeSessionId: string }
/** A reference as sessions and pages see it: the source a Side or Ask was opened from, or one the user added. */
export interface SessionRef extends SessionRefTarget { origin: 'source' | 'added'; title?: string; addedAt?: string }
export interface SessionRefs { revision: number; refs: SessionRef[] }

interface SavedHolder extends SessionRefTarget { revision: number; refs: Array<SessionRefTarget & { addedAt: string }> }
interface SavedRefs { version: 1; holders: SavedHolder[] }

/** Sessions whose references are kept; the least recently changed is forgotten first. */
const HOLDER_LIMIT = 4096;
const REF_LIMIT = 32;
const key = (ref: SessionRefTarget) => JSON.stringify([ref.providerId, ref.nativeSessionId]);
const same = (left: SessionRefTarget, right: SessionRefTarget) => key(left) === key(right);

/**
 * The sessions each session refers to, beyond a source grant, and a revision that changes with every change to them,
 * including the removal or return of the source. References name sessions; they grant nothing: what a session may read
 * is decided where it reads.
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
        .map(ref => ({ providerId: ref.providerId, nativeSessionId: ref.nativeSessionId, addedAt: ref.addedAt }));
      this.holders.set(key(holder), { providerId: holder.providerId, nativeSessionId: holder.nativeSessionId, revision: holder.revision, refs });
    }
  }

  async read(holder: SessionRefTarget): Promise<{ revision: number; refs: Array<SessionRefTarget & { addedAt: string }> }> {
    await this.ready;
    const saved = this.holders.get(key(holder));
    return { revision: saved?.revision ?? 0, refs: saved?.refs.map(ref => ({ ...ref })) ?? [] };
  }

  /** Adds a reference; false when the holder already has it. */
  async add(holder: SessionRefTarget, target: SessionRefTarget, now = new Date()): Promise<boolean> {
    await this.ready;
    const saved = this.holder(holder);
    if (saved.refs.some(ref => same(ref, target))) return false;
    if (saved.refs.length >= REF_LIMIT) throw new SessionRefError('invalid_request', `A session can reference at most ${REF_LIMIT} sessions.`);
    saved.refs.push({ providerId: target.providerId, nativeSessionId: target.nativeSessionId, addedAt: now.toISOString() });
    await this.changed(saved);
    return true;
  }

  /** Removes a reference; false when the holder does not have it. */
  async remove(holder: SessionRefTarget, target: SessionRefTarget): Promise<boolean> {
    await this.ready;
    const saved = this.holders.get(key(holder));
    if (!saved?.refs.some(ref => same(ref, target))) return false;
    saved.refs = saved.refs.filter(ref => !same(ref, target));
    await this.changed(saved);
    return true;
  }

  /** Records a change made elsewhere, such as the removal of the holder's source. */
  async touch(holder: SessionRefTarget): Promise<void> {
    await this.ready;
    await this.changed(this.holder(holder));
  }

  private holder(ref: SessionRefTarget): SavedHolder {
    let saved = this.holders.get(key(ref));
    if (!saved) this.holders.set(key(ref), saved = { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId, revision: 0, refs: [] });
    return saved;
  }

  private changed(saved: SavedHolder): Promise<void> {
    saved.revision += 1;
    this.holders.delete(key(saved));
    this.holders.set(key(saved), saved);
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
  /** The source a session references through its grant; removed once the user removed it. */
  source(holder: SessionRefTarget): Promise<{ sourceNativeSessionId: string; removed: boolean } | undefined>;
  setSourceRemoved(holder: SessionRefTarget, removed: boolean): Promise<boolean>;
  /** The title of a session on this Host, empty when it has none; undefined when the Host does not list it. */
  title(target: SessionRefTarget): Promise<string | undefined>;
}

export async function describeSessionRefs(holder: SessionRefTarget, context: SessionRefContext): Promise<SessionRefs> {
  const [saved, source] = await Promise.all([context.store.read(holder), context.source(holder)]);
  const refs: SessionRef[] = [];
  if (source && !source.removed) refs.push({ providerId: holder.providerId, nativeSessionId: source.sourceNativeSessionId, origin: 'source' });
  for (const ref of saved.refs) if (!refs.some(existing => same(existing, ref))) refs.push({ ...ref, origin: 'added' });
  const titled = await Promise.all(refs.map(async ref => {
    const title = await context.title(ref).catch(() => undefined);
    return title ? { ...ref, title } : ref;
  }));
  return { revision: saved.revision, refs: titled };
}

/** Adds or removes one reference. The source a Side or Ask was opened from is removed and restored like any other. */
export async function changeSessionRef(holder: SessionRefTarget, action: 'add' | 'remove', target: SessionRefTarget, context: SessionRefContext): Promise<SessionRefs> {
  if (same(holder, target)) throw new SessionRefError('invalid_request', 'A session cannot reference itself.');
  const source = await context.source(holder);
  const isSource = !!source && source.sourceNativeSessionId === target.nativeSessionId && target.providerId === holder.providerId;
  if (action === 'add') {
    if (isSource && source.removed) {
      if (await context.setSourceRemoved(holder, false)) await context.store.touch(holder);
    } else if (!isSource) {
      if (await context.title(target).catch(() => undefined) === undefined) throw new SessionRefError('session_not_found', 'No such session on this Host.');
      await context.store.add(holder, target);
    }
  } else if (isSource && !source.removed) {
    if (await context.setSourceRemoved(holder, true)) await context.store.touch(holder);
    await context.store.remove(holder, target);
  } else await context.store.remove(holder, target);
  return describeSessionRefs(holder, context);
}

export function validTarget(value: unknown): value is SessionRefTarget {
  const ref = value as Partial<SessionRefTarget> | null;
  return typeof ref?.providerId === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(ref.providerId)
    && typeof ref.nativeSessionId === 'string' && !!ref.nativeSessionId && ref.nativeSessionId.length <= 512;
}
