import { boundToolResult, projectResourceInputText, type AgentStreamEvent, type AgentTimelineItem, type AgentToolDetail, type ProviderItemIdentity } from '@orchardworks/agent-provider-sdk';
import { list, num, provider, record, str, type Json } from './native.js';
import { toolDetail, toolResult } from './tool-detail.js';

/** One observation of what pi did: its source key, what it says, the item it belongs to and when it happened. */
export interface Projected { key: string; event: AgentStreamEvent; identity?: ProviderItemIdentity; occurredAt?: number }

/** An entry of a pi session file (docs/session-format.md); only the fields the adapter reads are named. */
export interface PiEntry { type: string; id?: string; parentId?: string | null; timestamp?: string; message?: unknown; [field: string]: unknown }

// A pi message has no id of its own while it streams, and the session file keeps the same `timestamp` for it, so the timestamp (with the
// index of the content block) is what names an item live and when the file is read again.
const userKey = (timestamp: unknown) => `user:${String(timestamp)}`;
const blockKey = (kind: 'assistant' | 'reasoning', timestamp: unknown, index: number) => `${kind}:${String(timestamp)}:${index}`;
const toolKey = (callId: string) => `tool:${callId}`;
const errorKey = (timestamp: unknown) => `error:${String(timestamp)}`;
const compactionKey = (firstKept: unknown) => `compaction:${String(firstKept)}`;
const identity = (key: string, completes: boolean, liveOnly = false): ProviderItemIdentity => ({ key, ...(completes ? { completes: true as const } : {}), ...(liveOnly ? { liveOnly: true as const } : {}) });

/** The text of a user message: a string, or the text blocks of its content (images are named, not carried). */
export function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  return list(content).map(block => { const part = record(block); return part.type === 'text' ? str(part.text) ?? '' : part.type === 'image' ? '[image]' : ''; }).join('');
}

/** The user row for a message: resource references the Host wrote into the text become resource parts again. */
function userItem(content: unknown, timestamp: unknown): AgentTimelineItem {
  const text = userText(content);
  const parts = projectResourceInputText(text);
  const resources = parts.some(part => part.type === 'resource');
  return { type: 'user_message', text: resources ? parts.map(part => part.type === 'text' ? part.text : `[${part.label}]`).join('') : text, ...(resources ? { content: parts } : {}), messageId: String(timestamp) };
}

type Terminal = { type: 'turn_completed' } | { type: 'turn_failed'; error: string } | { type: 'turn_canceled'; reason: string };

/** How a run ended, from the stop reason of its last assistant message. */
function terminalOf(last: Json | undefined): Terminal {
  const stop = str(last?.stopReason);
  if (stop === 'error') return { type: 'turn_failed', error: str(last?.errorMessage) ?? 'The model request failed.' };
  if (stop === 'aborted') return { type: 'turn_canceled', reason: 'Native turn aborted' };
  if (stop === 'toolUse' || !last) return { type: 'turn_canceled', reason: 'The turn did not finish.' };
  return { type: 'turn_completed' };
}

interface Streaming { text: string; done: boolean }

/**
 * Folds pi's messages into rows. History comes from the session file (complete messages); live comes from RPC events (deltas). Both name
 * an item by the same key, so the Relay's journal recognizes the live item when the file is read again. Text and reasoning are append-only
 * deltas; the end of a block completes the item with whatever its stream lacked.
 */
export class PiProjector {
  private turnId: string | undefined;
  private starting = false;
  private active = false;
  private lastAssistant: Json | undefined;
  private readonly blocks = new Map<string, Streaming>();
  private readonly tools = new Map<string, { name: string; detail: AgentToolDetail }>();
  private readonly toolText = new Map<string, string>();
  constructor(private readonly cwd?: string) {}

  private timeline(item: AgentTimelineItem, key: string, id: ProviderItemIdentity, occurredAt?: number): Projected {
    return { key, event: { type: 'timeline', provider, item, ...(this.turnId ? { turnId: this.turnId } : {}) }, identity: id, ...(occurredAt !== undefined ? { occurredAt } : {}) };
  }
  private turnEvent(type: 'turn_started'): Projected;
  private turnEvent(type: 'terminal', terminal: Terminal): Projected;
  private turnEvent(type: 'turn_started' | 'terminal', terminal?: Terminal): Projected {
    const turnId = this.turnId;
    if (type === 'turn_started') return { key: `turn-started:${turnId}`, event: { type: 'turn_started', provider, turnId } };
    const t = terminal!;
    const event: AgentStreamEvent = t.type === 'turn_completed' ? { type: 'turn_completed', provider, turnId }
      : t.type === 'turn_failed' ? { type: 'turn_failed', provider, error: t.error, turnId } : { type: 'turn_canceled', provider, reason: t.reason, turnId };
    return { key: `turn-ended:${turnId}`, event };
  }

  // History -----------------------------------------------------------------------------------------------------------------------

  /** The rows of a session's active branch, in order, for the entries of its file. */
  history(entries: readonly PiEntry[]): Projected[] {
    const rows: Projected[] = [];
    const pending = new Map<string, { name: string; detail: AgentToolDetail; at: number }>();
    let open = false;
    let previous: Json | undefined;
    const finish = () => {
      if (!open) return;
      for (const [callId, call] of pending) rows.push(this.timeline({ type: 'tool_call', callId, name: call.name, detail: call.detail, status: 'canceled', error: null }, toolKey(callId), identity(toolKey(callId), true), call.at));
      pending.clear();
      rows.push(this.turnEvent('terminal', terminalOf(this.lastAssistant)));
      open = false; this.lastAssistant = undefined;
    };
    for (const entry of entries) {
      if (entry.type === 'compaction') {
        rows.push(this.timeline({ type: 'compaction', status: 'completed', preTokens: num(entry.tokensBefore) }, compactionKey(entry.firstKeptEntryId), identity(compactionKey(entry.firstKeptEntryId), true), Date.parse(entry.timestamp ?? '') || undefined));
        continue;
      }
      if (entry.type !== 'message') continue;
      const message = record(entry.message);
      const timestamp = message.timestamp;
      const at = num(timestamp);
      if (message.role === 'user') {
        // A user message after tool results or a tool-calling answer is steering inside the run; any other one starts a run.
        const continuing = open && (previous?.role === 'toolResult' || previous?.role === 'assistant' && previous.stopReason === 'toolUse');
        if (!continuing) { finish(); this.turnId = `turn:${String(timestamp)}`; }
        rows.push(this.timeline(userItem(message.content, timestamp), userKey(timestamp), identity(userKey(timestamp), true), at));
        if (!continuing) { rows.push(this.turnEvent('turn_started')); open = true; }
      } else if (message.role === 'assistant') {
        if (!open) { this.turnId = `turn:${String(timestamp)}`; rows.push(this.turnEvent('turn_started')); open = true; }
        this.lastAssistant = message;
        list(message.content).forEach((block, index) => {
          const part = record(block);
          if (part.type === 'text' && str(part.text)) rows.push(this.timeline({ type: 'assistant_message', text: str(part.text)!, messageId: `${String(timestamp)}:${index}` }, blockKey('assistant', timestamp, index), identity(blockKey('assistant', timestamp, index), true), at));
          else if (part.type === 'thinking' && str(part.thinking)?.trim()) rows.push(this.timeline({ type: 'reasoning', text: str(part.thinking)! }, blockKey('reasoning', timestamp, index), identity(blockKey('reasoning', timestamp, index), true), at));
          else if (part.type === 'toolCall' && str(part.id)) pending.set(str(part.id)!, { name: str(part.name) ?? 'tool', detail: toolDetail(str(part.name) ?? 'tool', part.arguments, this.cwd), at: at ?? 0 });
        });
        if (message.stopReason === 'error') rows.push(this.timeline({ type: 'error', message: str(message.errorMessage) ?? 'The model request failed.' }, errorKey(timestamp), identity(errorKey(timestamp), true), at));
      } else if (message.role === 'toolResult') {
        const callId = str(message.toolCallId) ?? '';
        const call = pending.get(callId) ?? { name: str(message.toolName) ?? 'tool', detail: toolDetail(str(message.toolName) ?? 'tool', {}, this.cwd), at: at ?? 0 };
        pending.delete(callId);
        const failed = message.isError === true;
        const result = toolResult(message, call.detail.type === 'shell');
        rows.push(this.timeline({ type: 'tool_call', callId, name: call.name, detail: call.detail, result, ...(failed ? { status: 'failed' as const, error: result.content.map(c => c.type === 'text' ? c.text : '').join('').slice(0, 500) || 'The tool failed.' } : { status: 'completed' as const, error: null }) }, toolKey(callId), identity(toolKey(callId), true), at));
      } else if (message.role === 'bashExecution') {
        const key = `bash:${String(timestamp)}`;
        const detail: AgentToolDetail = { type: 'shell', command: str(message.command) ?? '', ...(this.cwd ? { cwd: this.cwd } : {}) };
        const exitCode = num(message.exitCode);
        rows.push(this.timeline({ type: 'tool_call', callId: key, name: 'bash', detail, result: boundToolResult({ content: [{ type: 'text', text: str(message.output) ?? '', stream: 'combined' }], ...(exitCode !== undefined ? { exitCode } : {}), ...(message.truncated === true ? { truncated: true } : {}) }),
          ...(message.cancelled === true ? { status: 'canceled' as const, error: null } : exitCode === 0 || exitCode === undefined ? { status: 'completed' as const, error: null } : { status: 'failed' as const, error: `Exit code ${exitCode}` }) }, key, identity(key, true), at));
        continue;
      } else continue;
      previous = message;
    }
    finish();
    this.turnId = undefined;
    return rows;
  }

  // Live --------------------------------------------------------------------------------------------------------------------------

  /** A run began that no user message of this process started yet; its user message names the turn. */
  private start(rows: Projected[], timestamp: unknown): void {
    this.turnId = `turn:${String(timestamp)}`; this.active = true; this.starting = false; this.lastAssistant = undefined;
    rows.push(this.turnEvent('turn_started'));
  }

  /** The rows of one RPC event. */
  live(event: Json): Projected[] {
    const rows: Projected[] = [];
    switch (event.type) {
      case 'agent_start': this.starting = true; this.turnId = undefined; this.blocks.clear(); break;
      case 'message_end': {
        const message = record(event.message);
        if (message.role === 'user') {
          const timestamp = message.timestamp;
          const wasStarting = this.starting || !this.active;
          if (wasStarting) { this.turnId = `turn:${String(timestamp)}`; }
          rows.push(this.timeline(userItem(message.content, timestamp), userKey(timestamp), identity(userKey(timestamp), true), num(timestamp)));
          if (wasStarting) { this.active = true; this.starting = false; this.lastAssistant = undefined; rows.push(this.turnEvent('turn_started')); }
        } else if (message.role === 'assistant') {
          if (this.starting) this.start(rows, message.timestamp);
          this.lastAssistant = message;
          rows.push(...this.finishBlocks(message));
          if (message.stopReason === 'error') rows.push(this.timeline({ type: 'error', message: str(message.errorMessage) ?? 'The model request failed.' }, errorKey(message.timestamp), identity(errorKey(message.timestamp), true), num(message.timestamp)));
        }
        break;
      }
      case 'message_update': rows.push(...this.update(event)); break;
      case 'tool_execution_start': {
        if (this.starting) this.start(rows, Date.now());
        const callId = str(event.toolCallId) ?? '', name = str(event.toolName) ?? 'tool';
        const call = { name, detail: toolDetail(name, event.args, this.cwd) };
        this.tools.set(callId, call); this.toolText.delete(callId);
        rows.push(this.timeline({ type: 'tool_call', callId, ...call, status: 'running', error: null }, toolKey(callId), identity(toolKey(callId), false)));
        break;
      }
      case 'tool_execution_update': {
        const callId = str(event.toolCallId) ?? '';
        const call = this.tools.get(callId); if (!call) break;
        const result = toolResult(event.partialResult, call.detail.type === 'shell');
        const text = JSON.stringify(result);
        if (this.toolText.get(callId) === text) break;
        this.toolText.set(callId, text);
        rows.push(this.timeline({ type: 'tool_call', callId, ...call, status: 'running', error: null, result }, toolKey(callId), identity(toolKey(callId), false)));
        break;
      }
      case 'tool_execution_end': {
        const callId = str(event.toolCallId) ?? '';
        const call = this.tools.get(callId) ?? { name: str(event.toolName) ?? 'tool', detail: toolDetail(str(event.toolName) ?? 'tool', {}, this.cwd) };
        this.tools.delete(callId); this.toolText.delete(callId);
        const result = toolResult(event.result, call.detail.type === 'shell');
        const failed = event.isError === true;
        rows.push(this.timeline({ type: 'tool_call', callId, ...call, result, ...(failed ? { status: 'failed' as const, error: result.content.map(c => c.type === 'text' ? c.text : '').join('').slice(0, 500) || 'The tool failed.' } : { status: 'completed' as const, error: null }) }, toolKey(callId), identity(toolKey(callId), true)));
        break;
      }
      case 'compaction_end': {
        const result = record(event.result);
        if (event.aborted === true) break;
        const trigger = event.reason === 'manual' ? 'manual' as const : 'auto' as const;
        if (event.errorMessage || !event.result) {
          const key = `compaction:failed:${Date.now()}`;
          rows.push(this.timeline({ type: 'compaction', status: 'failed', trigger }, key, identity(key, true, true)));
          rows.push(this.timeline({ type: 'error', message: `pi compaction failed: ${str(event.errorMessage) ?? 'unknown error'}` }, `${key}:error`, identity(`error:${key}`, true, true)));
        } else rows.push(this.timeline({ type: 'compaction', status: 'completed', trigger, preTokens: num(result.tokensBefore) }, compactionKey(result.firstKeptEntryId), identity(compactionKey(result.firstKeptEntryId), true)));
        break;
      }
      case 'agent_end': {
        const messages = list(event.messages).map(record);
        const last = [...messages].reverse().find(message => message.role === 'assistant') ?? this.lastAssistant;
        // A run that ended without a user message of its own still has a turn to close.
        if (this.starting) this.start(rows, Date.now());
        if (this.active || this.turnId) {
          for (const [callId, call] of this.tools) rows.push(this.timeline({ type: 'tool_call', callId, ...call, status: 'canceled', error: null }, toolKey(callId), identity(toolKey(callId), true)));
          rows.push(this.turnEvent('terminal', terminalOf(last)));
        }
        this.tools.clear(); this.toolText.clear(); this.blocks.clear();
        this.active = false; this.starting = false; this.turnId = undefined; this.lastAssistant = undefined;
        break;
      }
      default: break;
    }
    return rows;
  }

  /** Whether a run of this process is under way. */
  get running(): boolean { return this.active || this.starting; }

  private update(event: Json): Projected[] {
    const rows: Projected[] = [];
    const delta = record(event.assistantMessageEvent);
    const message = record(event.message);
    const index = num(delta.contentIndex);
    if (index === undefined) return rows;
    if (this.starting) this.start(rows, message.timestamp);
    const timestamp = message.timestamp;
    if (delta.type === 'text_delta' || delta.type === 'thinking_delta') {
      const kind = delta.type === 'text_delta' ? 'assistant' as const : 'reasoning' as const;
      const key = blockKey(kind, timestamp, index);
      const text = str(delta.delta) ?? '';
      if (!text) return rows;
      const state = this.blocks.get(key) ?? { text: '', done: false };
      if (state.done) return rows;
      state.text += text; this.blocks.set(key, state);
      rows.push(this.timeline(kind === 'assistant' ? { type: 'assistant_message', text, messageId: `${String(timestamp)}:${index}` } : { type: 'reasoning', text }, key, identity(key, false), num(timestamp)));
    } else if (delta.type === 'text_end' || delta.type === 'thinking_end') {
      const kind = delta.type === 'text_end' ? 'assistant' as const : 'reasoning' as const;
      rows.push(...this.endBlock(kind, timestamp, index, str(delta.content) ?? ''));
    }
    return rows;
  }

  /** The end of a text or thinking block: the item completes with the part of its final content the stream lacked. */
  private endBlock(kind: 'assistant' | 'reasoning', timestamp: unknown, index: number, content: string): Projected[] {
    const key = blockKey(kind, timestamp, index);
    const state = this.blocks.get(key) ?? { text: '', done: false };
    if (state.done) return [];
    state.done = true; this.blocks.set(key, state);
    if (!state.text && !content.trim()) return [];
    const rest = content.startsWith(state.text) ? content.slice(state.text.length) : '';
    return [this.timeline(kind === 'assistant' ? { type: 'assistant_message', text: rest, messageId: `${String(timestamp)}:${index}` } : { type: 'reasoning', text: rest }, key, identity(key, true), num(timestamp))];
  }

  /** A message that ended without an end event for a block (a provider that does not stream) still completes every block. */
  private finishBlocks(message: Json): Projected[] {
    const rows: Projected[] = [];
    list(message.content).forEach((block, index) => {
      const part = record(block);
      if (part.type === 'text') rows.push(...this.endBlock('assistant', message.timestamp, index, str(part.text) ?? ''));
      else if (part.type === 'thinking') rows.push(...this.endBlock('reasoning', message.timestamp, index, str(part.thinking) ?? ''));
    });
    return rows;
  }
}

