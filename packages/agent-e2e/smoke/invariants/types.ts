// The two inputs of every smoke invariant, and the result each one returns. Invariants are pure functions of these inputs:
// they never read a clock, a file or the network, so a failing run can be replayed from its saved transcript and page report.

/** A decoded session-channel message, as the page and the Relay exchange it after the outer envelope is removed. */
export interface WireMessage {
  type: string;
  payload?: Record<string, any>;
  [key: string]: unknown;
}

/** One message crossing the proxy. `t` is milliseconds on the run's clock; `connection` numbers the WebSocket. */
export interface Frame {
  n: number;
  t: number;
  connection: number;
  /** The session-channel subscription the message belongs to, when it has one. */
  subscriptionId?: number;
  direction: 'browser->relay' | 'relay->browser';
  message: WireMessage;
}

export type MarkerName =
  | 'controller-restart' | 'relay-restart' | 'socket-open' | 'socket-close'
  | 'page-hidden' | 'page-visible' | 'offline' | 'online'
  | 'terminal-write' | 'turn-sent' | 'fault';

/** An event of the run that is not a message: a fault the schedule applied, or an action the scenario took. */
export interface Marker {
  n: number;
  t: number;
  marker: MarkerName;
  connection?: number;
  detail?: Record<string, unknown>;
}

export type TranscriptEntry = Frame | Marker;
export type Transcript = TranscriptEntry[];

/** What the page showed at one moment: the visible labels and counts of the conversation view. */
export interface PageSample {
  t: number;
  /** The status labels seen: business labels such as `Ready` or `Working`; a connection word here is a T5 violation. */
  labels: string[];
  /** Loading placeholders such as a skeleton heading; empty when a conversation or an empty state is shown. */
  loading: string[];
  messages: number;
  entries: number;
  composer: 'absent' | 'disabled' | 'enabled';
  delivery: string[];
}

export interface PageRow { key: string; kind: string; text: string; status?: string }

export interface PageReport {
  samples: PageSample[];
  /** Time from the start of an open to the first conversation row, and whether the rows came from the device store. */
  paints: Array<{ label: string; ms: number; fromDeviceStore: boolean; timedOut?: boolean }>;
  /** The item keys of the rendered timeline, in order, at each moment the scenario read them. */
  rowKeys: string[][];
  /** The rows shown at the end of the run. */
  finalRows: PageRow[];
  /** Rows marked before a fault or churn: how many were marked and how many are still the same element. */
  survivors?: { total: number; alive: number };
  composer?: { before: { text: string; focused: boolean }; after: { text: string; focused: boolean } };
  anchor?: { before: { key: string; offset: number } | null; after: { key: string; offset: number } | null };
  /** Resource series of one page, one entry per sampling tick. */
  resources?: Array<ResourceSample>;
  /** A fresh page that opened the same conversations after the run and loaded the rows the run's page held: what those rows cost without the run's history. */
  memoryReference?: ResourceSample;
}

/** One sampling tick: the heap after a collection, the rows beyond what the run wrote, every conversation row rendered, and the open sockets. */
export interface ResourceSample { t: number; heapBytes: number; rows: number; retainedRows?: number; sockets: number }

export type InvariantStatus = 'passed' | 'failed' | 'not_exercised';

export interface Violation {
  message: string;
  /** Time on the run's clock when it can be placed. */
  at?: number;
  detail?: unknown;
}

export interface InvariantResult {
  invariant: string;
  status: InvariantStatus;
  /** How many things the invariant examined; `not_exercised` means the run gave it nothing to examine. */
  checked: number;
  violations: Violation[];
}

/** Builds a result: `not_exercised` when nothing was examined, so a run that never reached the fault cannot pass by silence. */
export function result(invariant: string, checked: number, violations: Violation[]): InvariantResult {
  return { invariant, checked, violations, status: violations.length > 0 ? 'failed' : checked === 0 ? 'not_exercised' : 'passed' };
}

/**
 * M6's third input: what each round of writers racing on one session left behind. A writer is a page (its composer) or a terminal
 * (its CLI); a view is a place that shows the session: each page, and the native session read through the command line. A run's
 * rounds are kept in its report, so its M6 invariants replay from it as the others replay from the transcript.
 */
export interface RoundRecord {
  /** `codex terminal 3`, `claude two pages 1`. */
  label: string;
  /** When the round started, on the run's clock: its violations are placed there. */
  t?: number;
  writers: WriterRecord[];
  /** The native session's newest entries and facts, read after the round settled. */
  native: ViewRecord;
  pages: ViewRecord[];
  /** A terminal round: how long after the terminal's turn ended its rows appeared on each page (`null`: not within `boundMs`). */
  terminalShown?: { boundMs: number; afterMs: Array<number | null> };
  /** A round whose terminal joins the page's live session: whether each page said the session was working while the terminal's turn ran. */
  liveState?: { seenWorking: boolean[] };
}

/** One message of a round: its unique word, and what its writer was told. */
export interface WriterRecord {
  writer: string;
  word: string;
  /** The writer was told its message was taken: a page's send was acknowledged, a terminal's CLI ran the turn. */
  delivered: boolean;
  /** Tries it took: a terminal that Codex refused while another client's turn ran tries again. */
  tries: number;
  /** What the writer was told when its last try was refused. */
  refusal?: string;
}

/** The session as one place showed it: the person's messages (newest last), its activity, and its settings by label. */
export interface ViewRecord {
  name: string;
  userTexts: string[];
  status?: string;
  settings?: Record<string, string>;
}

/**
 * M6, beside a separate Codex process: Codex refuses the Controller while another process writes the session (its single writer).
 * What a page opened meanwhile showed, and whether the process's turn reached the page once it ended.
 */
export interface RefusalRecord {
  label: string;
  shown: { rows: number; status?: string; notice: string; retry: boolean; takeOver: boolean };
  /** From the process's end to its turn on the page; `null`: not within `boundMs`. */
  caughtUpMs: number | null;
  boundMs: number;
}
