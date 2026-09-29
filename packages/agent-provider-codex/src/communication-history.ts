import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { isRecord, readString } from './native.js';
import { CodexEventProjector } from './projector.js';
import { readCommunicationLog, type CommunicationLog, type CommunicationRecord, type CommunicationHistoryBase } from './communication-log.js';

interface ResolvedCommunicationLog extends CommunicationLog {
  sources: Array<{ id: string; parentId?: string; endTime: number }>;
}

/** Local compatibility fallback. RPC history remains authoritative whenever it supplies a message. */
export class CodexCommunicationHistory {
  private readonly logs = new Map<string, CommunicationLog>();
  private readonly metadata = new Map<string, Record<string, unknown>>();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly readThread: (id: string) => Promise<unknown>) {}

  rememberThread(thread: Record<string, unknown>): void {
    const id = readString(thread.id);
    if (id) {
      const metadata = { ...this.metadata.get(id), ...thread };
      delete metadata.turns;
      this.metadata.set(id, metadata);
    }
  }

  supplement(snapshot: unknown, observations: ProviderObservation[]): Promise<ProviderObservation[]> {
    const operation = this.pending.then(() => this.read(snapshot, observations));
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async read(snapshot: unknown, observations: ProviderObservation[]): Promise<ProviderObservation[]> {
    if (!isRecord(snapshot) || !isRecord(snapshot.thread)) return observations;
    const thread = snapshot.thread, id = readString(thread.id);
    if (!id) return observations;
    this.rememberThread(thread);
    const filePath = readString(this.metadata.get(id)?.path);
    if (!filePath) return observations;
    let log: ResolvedCommunicationLog;
    try { log = await this.load(id, filePath); }
    catch { return diagnostic(observations, id); }
    const turns = Array.isArray(thread.turns) ? thread.turns.filter(isRecord) : [];
    const turnIds = new Set(turns.map(t => readString(t.id)).filter((v): v is string => !!v));
    const starts = new Map(log.turns);
    for (const turn of turns) if (typeof turn.id === 'string' && typeof turn.startedAt === 'number') {
      starts.set(turn.id, Math.min(starts.get(turn.id) ?? Infinity, turn.startedAt * 1000));
    }
    const ranges = [...starts].sort((a, b) => a[1] - b[1]);
    const inPage = (time: number) => ranges.some(([turn, start], index) => turnIds.has(turn)
      && time >= start && time < (ranges[index + 1]?.[1] ?? Infinity));
    const messages: Array<{ message: CommunicationRecord; local: boolean }> = [...log.messages.values()]
      .filter(m => turnIds.has(m.turnId)).map(message => ({ message, local: true }));
    const peers = new Set<string>();
    const parent = readString(thread.parentThreadId) ?? log.parentId;
    if (parent) peers.add(parent);
    for (const source of log.sources) if (source.parentId) peers.add(source.parentId);
    for (const turn of turns) for (const item of Array.isArray(turn.items) ? turn.items : []) {
      if (!isRecord(item)) continue;
      if (item.type === 'subAgentActivity' && readString(item.agentThreadId)) peers.add(item.agentThreadId as string);
      if (item.type === 'collabAgentToolCall' && Array.isArray(item.receiverThreadIds)) {
        for (const target of item.receiverThreadIds) if (typeof target === 'string') peers.add(target);
      }
    }
    peers.delete(id);
    let incomplete = log.incomplete;
    const selfPath = agentPath(thread, log);
    if (selfPath) {
      const peerIds = [...peers];
      // Bound concurrent native metadata requests; never enumerate unrelated sessions or resume a peer.
      for (let offset = 0; offset < peerIds.length; offset += 4) {
        await Promise.all(peerIds.slice(offset, offset + 4).map(async peerId => {
          try {
            let metadata = this.metadata.get(peerId);
            if (!metadata) {
              const response = await this.readThread(peerId);
              if (!isRecord(response) || !isRecord(response.thread) || response.thread.id !== peerId) throw new Error('Peer identity mismatch');
              metadata = response.thread;
              this.rememberThread(metadata);
            }
            const peerPath = readString(metadata.path);
            if (!peerPath) return;
            const peer = await this.load(peerId, peerPath);
            const peerParent = readString(metadata.parentThreadId) ?? peer.parentId;
            const sources = log.sources.filter(source => peerParent === source.id
              || peerId === source.parentId || source.id === id && peerId === parent);
            if (!sources.length) return;
            const targetPath = agentPath(metadata, peer);
            for (const message of peer.messages.values()) {
              if (message.sender === selfPath && message.recipient === targetPath && inPage(message.time)
                && sources.some(source => message.time <= source.endTime)) messages.push({ message, local: false });
            }
            incomplete ||= peer.incomplete;
          } catch { incomplete = true; }
        }));
      }
    }
    const projector = new CodexEventProjector(id, { delivery: 'history' });
    const existing = new Set(observations.map(o => o.sourceKey));
    const before = new Map<number, ProviderObservation[]>();
    const localMessages = messages.filter(m => m.local).sort((a, b) => a.message.position - b.message.position);
    const mirrored = messages.filter(m => !m.local).sort((a, b) => a.message.time - b.message.time || a.message.id.localeCompare(b.message.id));
    const sorted: typeof messages = [];
    let peerIndex = 0;
    for (const local of localMessages) {
      while (peerIndex < mirrored.length && mirrored[peerIndex]!.message.time <= local.message.time) sorted.push(mirrored[peerIndex++]!);
      sorted.push(local);
    }
    sorted.push(...mirrored.slice(peerIndex));
    for (const { message, local } of sorted) {
      const sourceKey = `item:${message.id}:completed`;
      if (existing.has(sourceKey)) continue;
      existing.add(sourceKey);
      const observation = projector.projectHistoryItem({ type: 'agentCommunication', id: message.id,
        sender: message.sender, recipient: message.recipient, text: message.text }, local ? message.turnId : undefined, message.time);
      if (!observation) continue;
      if (!local && observation.event.type === 'timeline') delete observation.event.turnId;
      let index = observations.findIndex(o => {
        const anchor = log.anchors.get(o.sourceKey);
        return anchor ? local ? anchor.turnId === message.turnId && anchor.position > message.position : anchor.time > message.time
          : !local && o.occurredAt !== undefined && o.occurredAt > message.time;
      });
      if (index < 0 && local) {
        let last = -1;
        for (let n = observations.length - 1; n >= 0; n--) {
          const event = observations[n]!.event;
          if ('turnId' in event && event.turnId === message.turnId) { last = n; break; }
        }
        if (last >= 0) index = last + 1;
      }
      if (index < 0) index = observations.length;
      const bucket = before.get(index) ?? []; bucket.push(observation); before.set(index, bucket);
    }
    const result = observations.flatMap((observation, index) => [...(before.get(index) ?? []), observation]);
    result.push(...(before.get(observations.length) ?? []));
    return incomplete ? diagnostic(result, id) : result;
  }

  private async load(id: string, filePath: string, end?: CommunicationHistoryBase, ancestors = new Set<string>()): Promise<ResolvedCommunicationLog> {
    if (ancestors.has(id) || ancestors.size >= 32) throw new Error('Invalid communication history lineage');
    const key = JSON.stringify([id, end?.endOrdinalExclusive, end?.endByteOffset]);
    const log = await readCommunicationLog(filePath, id, this.logs.get(key), end);
    this.logs.delete(key); this.logs.set(key, log);
    // Readers belong to a session view. Bound the working set of large parent/child histories.
    if (this.logs.size > 32) this.logs.delete(this.logs.keys().next().value!);
    const resolved: ResolvedCommunicationLog = { ...log, sources: [{ id, parentId: log.parentId, endTime: end ? log.latestTime : Infinity }] };
    if (!log.historyBase) return resolved;
    // A lazy fork owns only its tail. Expand the immutable prefix before projecting its turns.
    // Keep raw cache entries separate from composed histories and from other fork boundaries.
    const base = log.historyBase;
    try {
      let metadata = this.metadata.get(base.threadId);
      if (!metadata) {
        const response = await this.readThread(base.threadId);
        if (!isRecord(response) || !isRecord(response.thread) || response.thread.id !== base.threadId) {
          throw new Error('Communication history base identity mismatch');
        }
        metadata = response.thread;
        this.rememberThread(metadata);
      }
      const basePath = readString(metadata.path);
      if (!basePath) throw new Error('Communication history base path is unavailable');
      const inherited = await this.load(base.threadId, basePath, base, new Set([...ancestors, id]));
      const shift = inherited.lines;
      return { ...resolved, incomplete: log.incomplete || inherited.incomplete, lines: shift + log.lines,
        agentPath: log.agentPath ?? inherited.agentPath,
        sources: [...inherited.sources, ...resolved.sources],
        messages: new Map([...inherited.messages, ...[...log.messages].map(([key, message]) =>
          [key, { ...message, position: shift + message.position }] as const)]),
        anchors: new Map([...inherited.anchors, ...[...log.anchors].map(([key, anchor]) =>
          [key, { ...anchor, position: shift + anchor.position }] as const)]),
        turns: new Map([...inherited.turns, ...log.turns]),
      };
    } catch { return { ...resolved, incomplete: true }; }
  }
}

function agentPath(thread: Record<string, unknown>, log: CommunicationLog): string | undefined {
  const source = isRecord(thread.source) && isRecord(thread.source.subAgent) && isRecord(thread.source.subAgent.thread_spawn)
    ? thread.source.subAgent.thread_spawn : {};
  const explicit = readString(thread.agentPath) ?? readString(source.agent_path) ?? log.agentPath;
  if (explicit) return explicit;
  // Earlier roots omit agent_path. A unanimous recorded recipient is evidence; a guessed '/root' is not.
  const recipients = new Set([...log.messages.values()].map(message => message.recipient));
  return recipients.size === 1 ? recipients.values().next().value : undefined;
}

function diagnostic(observations: ProviderObservation[], id: string): ProviderObservation[] {
  const sourceKey = `communication-history:${id}:unavailable`;
  if (observations.some(o => o.sourceKey === sourceKey)) return observations;
  return [...observations, { type: 'observation', sourceKey, occurredAt: observations.at(-1)?.occurredAt ?? Date.now(), delivery: 'history', event: { type: 'timeline', provider: 'codex',
    item: { type: 'error', message: 'Some agent communication history could not be recovered from local records. Other session history is still available.' } } }];
}
