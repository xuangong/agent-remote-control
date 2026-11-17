import type { Frame, Marker, MarkerName, PageReport, PageSample, Transcript, WireMessage } from './types.js';

/** Builds a transcript the way the proxy would have recorded it: frame numbers and the connection are filled in. */
export class TranscriptBuilder {
  readonly entries: Transcript = [];
  private count = 0;
  constructor(private connection = 1) {}

  onConnection(connection: number): this { this.connection = connection; return this; }

  send(t: number, type: string, payload: Record<string, unknown> = {}, extra: Partial<Frame> = {}): this {
    return this.add({ n: ++this.count, t, connection: this.connection, direction: 'browser->relay', message: message(type, payload), ...extra });
  }
  receive(t: number, type: string, payload: Record<string, unknown> = {}, extra: Partial<Frame> = {}): this {
    return this.add({ n: ++this.count, t, connection: this.connection, direction: 'relay->browser', message: message(type, payload), ...extra });
  }
  marker(t: number, marker: MarkerName, detail?: Record<string, unknown>, connection?: number): this {
    const entry: Marker = { n: ++this.count, t, marker, ...(detail ? { detail } : {}), ...(connection === undefined ? {} : { connection }) };
    return this.add(entry);
  }
  build(): Transcript { return [...this.entries]; }
  private add(entry: Transcript[number]): this { this.entries.push(entry); return this; }
}

const message = (type: string, payload: Record<string, unknown>): WireMessage => ({ protocolVersion: '1.8.0', type, payload });

export const transcript = (): TranscriptBuilder => new TranscriptBuilder();

export const streamEntry = (epoch: string, seq: number, agentId = 'agent', extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ agentId, epoch, seq, timestamp: '<iso>', event: { type: 'timeline', providerId: 'claude', item: { type: 'assistant_message', text: `t${seq}` }, resources: [] }, ...extra });

export const tailPage = (epoch: string, minSeq: number, maxSeq: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  requestId: 'page', agentId: 'agent', direction: 'tail', epoch, reset: false, staleCursor: false, gap: false, error: null,
  window: { minSeq, maxSeq, nextSeq: maxSeq + 1 }, startCursor: { epoch, seq: minSeq }, endCursor: { epoch, seq: maxSeq },
  hasOlder: minSeq > 1, hasNewer: false,
  entries: Array.from({ length: maxSeq - minSeq + 1 }, (_, at) => ({ itemKey: `k${minSeq + at}`, seqStart: minSeq + at, seqEnd: minSeq + at, item: { type: 'assistant_message', text: 'x' } })),
  ...extra,
});

export const sample = (t: number, extra: Partial<PageSample> = {}): PageSample =>
  ({ t, labels: ['Ready'], loading: [], messages: 4, entries: 4, composer: 'enabled', delivery: [], ...extra });

export const page = (extra: Partial<PageReport> = {}): PageReport => ({ samples: [], paints: [], rowKeys: [], finalRows: [], ...extra });
