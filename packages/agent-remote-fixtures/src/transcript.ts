/**
 * A transcript is a normalized JSON-lines capture of one wire scenario: a header line, then frames in the order they were sent,
 * each with its direction, and step markers that name what the scenario was doing. Ids, times and tokens are placeholders
 * (`<uuid:1>`, `<time>`, `<token:1>`), numbered by first appearance, so recording the same scenario twice gives the same file.
 */
export type Seam = 'S2' | 'S3';
export type Direction = 'controller->relay' | 'relay->controller' | 'browser->relay' | 'relay->browser';
export type Role = 'controller' | 'browser' | 'relay';

export interface TranscriptHeader {
  kind: 'transcript';
  seam: Seam;
  scenario: string;
  description: string;
  /** The tool that wrote the file; a person edits a transcript only by recording it again. */
  producedBy: 'transcripts:record';
  protocolVersion: string;
  /** The repository state the file was recorded at. */
  recordedAt: string;
  /** Test files that replay it; `pnpm fixtures:check` fails for a transcript no consumer names. */
  consumers: string[];
}

export interface TranscriptFrame { n: number; direction: Direction; message: unknown }
export interface TranscriptStep { step: string }
export type TranscriptLine = TranscriptFrame | TranscriptStep;
export interface Transcript { header: TranscriptHeader; lines: TranscriptLine[] }

export const isFrame = (line: TranscriptLine): line is TranscriptFrame => 'direction' in line;
export const framesOf = (transcript: Transcript, direction?: Direction): TranscriptFrame[] => transcript.lines.filter(isFrame).filter(frame => direction === undefined || frame.direction === direction);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const TIME_KEY = /(^|[a-z])(At|Time)$|^(at|ts|timestamp|expires|observedAt)$/;
const TOKEN_KEY = /(token|nonce|secret)$|^key$/i;
const RANDOM_REQUEST = /^(.*?-)0\.\d+$/;
/** The key of a string a message carries as JSON, such as a stream message of the uplink. */
const JSON_STRING_KEYS = new Set(['message', 'body']);

/**
 * Replaces what changes from run to run. The returned function normalizes one message and remembers each placeholder's number, so the
 * same identity is the same placeholder through the whole transcript. A JSON string under a `message` or `body` key is parsed and
 * normalized as `{ "$json": value }`.
 */
export function createNormalizer() {
  const numbers = new Map<string, number>();
  const placeholder = (kind: string, value: string) => {
    const key = `${kind}:${value}`;
    if (!numbers.has(key)) numbers.set(key, [...numbers.keys()].filter(known => known.startsWith(`${kind}:`)).length + 1);
    return `<${kind}:${numbers.get(key)}>`;
  };
  const text = (value: string, key: string): unknown => {
    if (TOKEN_KEY.test(key) && value.length > 0) return placeholder('token', value);
    if (ISO_TIME.test(value)) return '<iso>';
    const random = RANDOM_REQUEST.exec(value);
    if (random) return `${random[1]}${placeholder('random', value)}`;
    return value.replace(UUID, found => placeholder('uuid', found));
  };
  const walk = (value: unknown, key: string): unknown => {
    if (typeof value === 'string') {
      if (JSON_STRING_KEYS.has(key) && /^[{[]/.test(value)) {
        try { return { $json: walk(JSON.parse(value), key) }; } catch { /* not JSON after all */ }
      }
      return text(value, key);
    }
    if (typeof value === 'number') return TIME_KEY.test(key) ? '<time>' : value;
    if (Array.isArray(value)) return value.map(item => walk(item, key));
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, walk(item, name)]));
    return value;
  };
  return (message: unknown): unknown => walk(message, '');
}

/** Collects the frames of one scenario as the two ends of a socket send them. */
export function createRecorder(header: Omit<TranscriptHeader, 'kind' | 'producedBy'>) {
  const normalize = createNormalizer();
  const lines: TranscriptLine[] = [];
  let n = 0;
  return {
    /** A frame in `direction`; `json` is what the socket carried. */
    frame(direction: Direction, json: string): void { lines.push({ n: ++n, direction, message: normalize(JSON.parse(json)) }); },
    step(step: string): void { lines.push({ step }); },
    finish(): Transcript { return { header: { kind: 'transcript', producedBy: 'transcripts:record', ...header }, lines }; },
  };
}

export const serializeTranscript = (transcript: Transcript): string =>
  `${[transcript.header, ...transcript.lines].map(line => JSON.stringify(line)).join('\n')}\n`;

export function parseTranscript(text: string): Transcript {
  const [first, ...rest] = text.split('\n').filter(line => line.trim() !== '');
  const header = JSON.parse(first ?? '{}') as TranscriptHeader;
  if (header.kind !== 'transcript') throw new Error('The first line of a transcript is its header.');
  return { header, lines: rest.map(line => JSON.parse(line) as TranscriptLine) };
}

type Bindings = Map<string, string>;
const PLACEHOLDER = /^<(uuid|token|random):(\d+)>$/;
const PLACEHOLDER_WITHIN = /<(uuid|token|random):(\d+)>/g;

/**
 * Compares a frame a real module produced with a transcript's frame: placeholders match anything of their kind and bind to the first
 * value seen, and a bound placeholder must match the same value afterwards. Returns what differs, or undefined when it conforms.
 */
export function mismatch(expected: unknown, actual: unknown, bindings: Bindings, path = '$'): string | undefined {
  if (typeof expected === 'string') {
    if (expected === '<time>') return typeof actual === 'number' ? undefined : `${path}: expected a time, got ${JSON.stringify(actual)}`;
    if (expected === '<iso>') return typeof actual === 'string' && ISO_TIME.test(actual) ? undefined : `${path}: expected an ISO time, got ${JSON.stringify(actual)}`;
    if (typeof actual !== 'string') return `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    if (!PLACEHOLDER_WITHIN.test(expected)) return expected === actual ? undefined : `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    PLACEHOLDER_WITHIN.lastIndex = 0;
    // A string with placeholders in it: the literal parts must match and the placeholders bind to what stands in their place.
    const names: string[] = [];
    const pattern = new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/<(uuid|token|random):(\d+)>/g, (_whole, kind, number) => { names.push(`${kind}:${number}`); return '(.+?)'; })}$`);
    const found = pattern.exec(actual);
    if (!found) return `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    for (const [at, name] of names.entries()) {
      const value = found[at + 1]!;
      if (!bindings.has(name)) bindings.set(name, value);
      else if (bindings.get(name) !== value) return `${path}: ${name} was ${bindings.get(name)}, now ${value}`;
    }
    return undefined;
  }
  if (expected !== null && typeof expected === 'object' && '$json' in expected && Object.keys(expected).length === 1) {
    if (typeof actual !== 'string') return `${path}: expected a JSON string, got ${JSON.stringify(actual)}`;
    try { return mismatch((expected as { $json: unknown }).$json, JSON.parse(actual), bindings, `${path}.$json`); } catch { return `${path}: not JSON`; }
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return `${path}: expected ${expected.length} items, got ${Array.isArray(actual) ? actual.length : JSON.stringify(actual)}`;
    for (const [at, item] of expected.entries()) { const difference = mismatch(item, actual[at], bindings, `${path}[${at}]`); if (difference) return difference; }
    return undefined;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return `${path}: expected an object, got ${JSON.stringify(actual)}`;
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      if (!(key in expected)) return `${path}.${key}: unexpected field`;
      if (!(key in actual)) return `${path}.${key}: missing field`;
      const difference = mismatch((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], bindings, `${path}.${key}`);
      if (difference) return difference;
    }
    return undefined;
  }
  return Object.is(expected, actual) ? undefined : `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

/** A transcript frame as a module would send it now: bound placeholders become what the other side said, the rest stable stand-ins. */
export function materialize(message: unknown, bindings: Bindings): unknown {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (value === '<time>') return 10_000;
      if (value === '<iso>') return '2026-11-15T00:00:00.000Z';
      return value.replace(PLACEHOLDER_WITHIN, (_whole, kind: string, number: string) => {
        // A stand-in is what this side said, so the other side's frame must echo it: it binds like a value seen on the wire.
        const name = `${kind}:${number}`;
        if (!bindings.has(name)) bindings.set(name, kind === 'uuid' ? `00000000-0000-4000-8000-${number.padStart(12, '0')}` : `${kind}-${number}`);
        return bindings.get(name)!;
      });
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length === 1 && entries[0]![0] === '$json') return JSON.stringify(walk(entries[0]![1]));
      return Object.fromEntries(entries.map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  return walk(message);
}

/** One end of a socket as a player uses it. */
export interface PlayerPeer {
  /** Sends one frame as JSON. */
  send(json: string): void;
  /** The next frame the other side sent, as parsed JSON. */
  next(): Promise<unknown>;
}

/**
 * Plays one role of a transcript against a real module: it sends the role's frames in order and, before each of them, waits for
 * every frame the transcript has the other side send earlier. A frame that differs from the transcript fails with its position.
 * `onStep` runs at each step marker, where a scenario's own action (a clock advance, a call) happens.
 * Throws on the first difference; resolves with the number of frames received.
 */
export async function playRole(transcript: Transcript, role: Role, peer: PlayerPeer, onStep?: (step: string) => void | Promise<void>): Promise<number> {
  const bindings: Bindings = new Map();
  let received = 0;
  for (const line of transcript.lines) {
    if (!isFrame(line)) { await onStep?.(line.step); continue; }
    const frame = line;
    if (frame.direction.startsWith(role)) { peer.send(JSON.stringify(materialize(frame.message, bindings))); continue; }
    const actual = await peer.next();
    const difference = mismatch(frame.message, actual, bindings);
    if (difference) throw new Error(`${transcript.header.scenario}, frame ${frame.n} (${frame.direction}): ${difference}`);
    received += 1;
  }
  return received;
}
