import { projectResourceInputText } from '@orchardworks/agent-provider-sdk';
import {claudeFileChanges} from './tool-result.js';
import { boundToolResult, type AgentUserMessagePart, type ProviderItemIdentity, type ProviderResourceReference, type AgentToolResultJson, type AgentStreamEvent, type AgentTimelineItem, type AgentToolDetail, type ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { ClaudeImageRegistry } from './images.js';

export function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function toolDetail(name: string, input: Record<string, unknown>): AgentToolDetail {
  const text = (key: string) => typeof input[key] === 'string' ? input[key] as string : '';
  if (name === 'Bash') return { type: 'shell', command: text('command') };
  if (name === 'Read') return { type: 'read', filePath: text('file_path') };
  if (name === 'Edit' || name === 'MultiEdit') return { type: 'edit', filePath: text('file_path') };
  if (name === 'Write') return { type: 'write', filePath: text('file_path') };
  if (name === 'Grep' || name === 'Glob' || name === 'WebSearch') return { type: 'search', query: text('pattern') || text('query') };
  if (name === 'WebFetch') return { type: 'fetch', url: text('url') };
  return { type: 'other', description: text('description') || name };
}

interface Block { index: number; type: string; text: string; finalized: boolean }

/** One item of a journal: its key, whether this observation finishes it, and whether native history cannot rebuild it. */
const identity = (key: string, completes = false, liveOnly = false): ProviderItemIdentity =>
  ({ key, ...(completes ? { completes: true as const } : {}), ...(liveOnly ? { liveOnly: true as const } : {}) });

/** The envelope the transcript writes for a slash command the user typed, which the live row holds as typed. */
const COMMAND_ENVELOPE = /^\s*(?:<command-message>[^<]*<\/command-message>\s*)?<command-name>(\/[^<\s]*)<\/command-name>\s*(?:<command-message>[^<]*<\/command-message>\s*)?(?:<command-args>([^<]*)<\/command-args>)?\s*$/;
const typedCommand = (text: string): string => {
  const match = COMMAND_ENVELOPE.exec(text);
  return match ? `${match[1]}${match[2]?.trim() ? ` ${match[2].trim()}` : ''}` : text;
};

/** Converts native transcript and streaming frames to append-only normalized observations. */
export class ClaudeEventProjector {
  private readonly seen = new Set<string>();
  private readonly blocks = new Map<string, Block[]>();
  private readonly tools = new Map<string, { name: string; detail: AgentToolDetail }>();
  private activeMessage = '';
  private pendingCompaction: string | undefined;
  private sequence = 0;

  constructor(private readonly sessionId: string, private readonly delivery: 'history' | 'live' = 'live', private readonly images = new ClaudeImageRegistry(sessionId)) {}

  project(value: unknown): ProviderObservation[] {
    if (!record(value) || value.parent_tool_use_id || value.session_id && value.session_id !== this.sessionId) return [];
    if (value.type === 'stream_event') return this.stream(value.event);
    // A native record says when it was written, so history read again keeps that time; older emitters omit it.
    const written = typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN;
    const observations = this.projectRecord(value);
    return Number.isFinite(written) ? observations.map(observation => ({ ...observation, occurredAt: written })) : observations;
  }

  private projectRecord(value: Record<string, any>): ProviderObservation[] {
    if (typeof value.uuid === 'string') {
      if (this.seen.has(value.uuid)) return [];
      this.seen.add(value.uuid);
    }
    const key = `message:${value.uuid ?? ++this.sequence}`;
    if (value.type === 'system' && value.subtype === 'status' && value.status === 'compacting') {
      this.pendingCompaction = String(value.uuid ?? key);
      return [this.item(key, {type:'compaction',status:'loading'}, identity(`compaction:${this.pendingCompaction}`))];
    }
    if (value.type === 'system' && value.subtype === 'compact_boundary') {
      // The boundary ends the compaction the status row opened; one without a status row is a compaction of its own.
      const compaction = this.pendingCompaction ?? String(value.uuid ?? key);
      this.pendingCompaction = undefined;
      return [this.item(key, { type: 'compaction', status: 'completed',
        ...(record(value.compact_metadata) ? { trigger: value.compact_metadata.trigger, preTokens: value.compact_metadata.pre_tokens } : {}) }, identity(`compaction:${compaction}`, true))];
    }
    if (!record(value.message)) return [];
    const content = typeof value.message.content === 'string' ? [{ type: 'text', text: value.message.content }]
      : Array.isArray(value.message.content) ? value.message.content : [];
    if (value.type === 'user') {
      const events: ProviderObservation[] = [];
      const parts: AgentUserMessagePart[] = [];
      const resourceReferences: ProviderResourceReference[] = [];
      let imageIndex = 0;
      for (const [index, block] of content.entries()) {
        if (!record(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') parts.push(...projectResourceInputText(block.text));
        else if (block.type === 'image') {
          const image = this.images.projectUser(key, index, block, `image #${++imageIndex}`);
          parts.push(image.part);
          resourceReferences.push(...image.resourceReferences);
        }
      }
      const text = typedCommand(parts.map(part => part.type === 'text' ? part.text : `[${part.label}]`).join(imageIndex ? '' : '\n'));
      if (text && !value.isSynthetic) events.push({ ...this.item(key, { type: 'user_message', text, messageId: value.uuid,
        ...(parts.some(part=>part.type!=='text') ? { content: parts } : {}) }, identity(`user:${value.uuid ?? key}`, true)), ...(imageIndex ? { resourceReferences } : {}) });
      const toolResults = content.filter((block: unknown) => record(block) && block.type === 'tool_result');
      const structured = toolResults.length === 1 ? toolResultJson(imageMetadata(value.tool_use_result, toolResults[0].content)) : undefined;
      for (const block of toolResults) {
        const tool = this.tools.get(block.tool_use_id) ?? { name: 'Tool', detail: { type: 'other', description: 'Native tool result' } as const };
        const output = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
          ? block.content.filter((part: unknown) => record(part) && part.type === 'text').map((part: any) => part.text).join('\n') : '';
        const fileChanges = !block.is_error && toolResults.length === 1 ? claudeFileChanges(tool.name, value.tool_use_result) : undefined;
        const metadata = fileChanges ?? structured;
        const result = boundToolResult({ content: [{ type: 'text', text: output },
          ...(metadata === undefined ? [] : [{ type: 'json' as const, value: metadata }])] });
        events.push(this.item(`${key}:tool:${block.tool_use_id}`, { type: 'tool_call', callId: block.tool_use_id, ...tool, result,
          ...(block.is_error ? { status: 'failed' as const, error: output.slice(0, 1024) || 'Tool failed' } : { status: 'completed' as const, error: null }) }, identity(`tool:${block.tool_use_id}`, true)));
        if (typeof block.tool_use_id === 'string' && Array.isArray(block.content)) {
          for (const [index, part] of block.content.entries()) {
            const image = this.images?.project(block.tool_use_id, index, part);
            if (image) events.push({ ...this.item(`${key}:tool:${block.tool_use_id}:image:${index}`, image.item, identity(`tool:${block.tool_use_id}:image:${index}`, true)), resourceReferences: image.resourceReferences });
          }
        }
      }
      return events;
    }
    if (value.type !== 'assistant') return [];
    const messageId = typeof value.message.id === 'string' ? value.message.id : String(value.uuid);
    const blocks = this.blocks.get(messageId) ?? [];
    this.blocks.set(messageId, blocks);
    const events: ProviderObservation[] = [];
    for (const block of content) {
      if (!record(block)) continue;
      const current = blocks.find((entry) => !entry.finalized && entry.type === block.type)
        ?? { index: blocks.length, type: block.type, text: '', finalized: false };
      if (!blocks.includes(current)) blocks.push(current);
      current.finalized = true;
      const blockKey = `${key}:${current.index}`;
      if (block.type === 'text' || block.type === 'thinking') {
        const text = block.type === 'text' ? block.text : block.thinking;
        if (typeof text !== 'string') continue;
        const streamed = current.text;
        current.text = text;
        const reasoning = block.type === 'thinking';
        const itemKey = `${reasoning ? 'reasoning' : 'assistant'}:${messageId}:${current.index}`;
        const body = (value: string): AgentTimelineItem => reasoning ? { type: 'reasoning', text: value } : { type: 'assistant_message', messageId: `${messageId}:${current.index}`, text: value };
        // A text the stream never showed is a local command's own output when the record is synthetic; history cannot rebuild it.
        const liveOnly = this.delivery === 'live' && value.message.model === '<synthetic>';
        // The record finishes the item with what the stream lacks, nothing when it was whole.
        if (text.startsWith(streamed)) { if (streamed || text) events.push(this.item(blockKey, body(text.slice(streamed.length)), identity(itemKey, true, liveOnly))); continue; }
        // A final that does not continue the stream cannot rewrite it: the item ends as streamed, and the corrected text stands beside it.
        events.push(this.item(blockKey, body(''), identity(itemKey, true)));
        if (!reasoning && text) events.push(this.item(`${blockKey}:correction`, body(text), identity(`${itemKey}:correction`, true)));
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        const input = record(block.input) ? block.input : {};
        const tool = { name: block.name, detail: toolDetail(block.name, input) };
        this.tools.set(block.id, tool);
        events.push(this.item(blockKey, { type: 'tool_call', callId: block.id, ...tool, status: 'running', error: null }, identity(`tool:${block.id}`)));
        if (block.name === 'TodoWrite' && Array.isArray(input.todos)) events.push(this.item(`${blockKey}:todo`, { type: 'todo',
          items: input.todos.filter((todo: unknown) => record(todo) && typeof todo.content === 'string').map((todo: any) => ({ text: todo.content,
            completed: todo.status === 'completed', ...( ['pending', 'in_progress', 'completed'].includes(todo.status) ? { status: todo.status } : {}) })) }, identity(`todo:${block.id}`, true)));
      }
    }
    return events;
  }

  private stream(value: unknown): ProviderObservation[] {
    if (!record(value)) return [];
    if (value.type === 'message_start' && record(value.message)) {
      this.activeMessage = String(value.message.id);
      if (!this.blocks.has(this.activeMessage)) this.blocks.set(this.activeMessage, []);
      return [];
    }
    if (!this.activeMessage) return [];
    const blocks = this.blocks.get(this.activeMessage)!;
    if (value.type === 'content_block_start' && record(value.content_block)) {
      const block = value.content_block;
      const current = { index: value.index, type: block.type, text: '', finalized: false };
      blocks.push(current);
      return this.delta(current, block.type === 'thinking' ? block.thinking : block.text);
    }
    if (value.type === 'content_block_delta' && record(value.delta)) {
      const current = blocks.find(({ index }) => index === value.index);
      if (!current || current.finalized || !['text_delta', 'thinking_delta'].includes(value.delta.type)) return [];
      return this.delta(current, value.delta.type === 'thinking_delta' ? value.delta.thinking : value.delta.text);
    }
    return [];
  }

  private delta(block: Block, text: unknown): ProviderObservation[] {
    if (typeof text !== 'string' || !text) return [];
    block.text += text;
    return [this.item(`stream:${this.activeMessage}:${block.index}:${block.text.length}`, block.type === 'thinking'
      ? { type: 'reasoning', text } : { type: 'assistant_message', messageId: `${this.activeMessage}:${block.index}`, text },
      identity(`${block.type === 'thinking' ? 'reasoning' : 'assistant'}:${this.activeMessage}:${block.index}`))];
  }

  /**
   * The turn ended with these items open: a text or thinking block that streamed and never received its record ends with an empty body,
   * and a compaction that never reached its boundary is failed. Native history keeps none of them, so the next replacement may drop them.
   */
  finishOpenItems(): ProviderObservation[] {
    const finished: ProviderObservation[] = [];
    for (const [messageId, blocks] of this.blocks) {
      for (const block of blocks) {
        if (block.finalized || !block.text || (block.type !== 'text' && block.type !== 'thinking')) continue;
        block.finalized = true;
        const reasoning = block.type === 'thinking';
        finished.push(this.item(`abandoned:${messageId}:${block.index}`, reasoning ? { type: 'reasoning', text: '' } : { type: 'assistant_message', messageId: `${messageId}:${block.index}`, text: '' },
          identity(`${reasoning ? 'reasoning' : 'assistant'}:${messageId}:${block.index}`, true)));
      }
    }
    if (this.pendingCompaction) {
      finished.push(this.item(`abandoned:compaction:${this.pendingCompaction}`, { type: 'compaction', status: 'failed' }, identity(`compaction:${this.pendingCompaction}`, true)));
      this.pendingCompaction = undefined;
    }
    return finished;
  }

  private item(key: string, item: AgentTimelineItem, itemIdentity: ProviderItemIdentity): ProviderObservation {
    return { ...this.observation(key, { type: 'timeline', provider: 'claude', item }), itemIdentity };
  }

  private observation(sourceKey: string, event: AgentStreamEvent): ProviderObservation {
    return { type: 'observation', sourceKey: `claude:${this.sessionId}:${sourceKey}`, occurredAt: Date.now(), delivery: this.delivery, event };
  }
}

function imageMetadata(value: unknown, content: unknown): unknown {
  if (!record(value) || value.type !== 'image' || !record(value.file) || typeof value.file.base64 !== 'string' || !Array.isArray(content)) return value;
  const file = value.file;
  const correlated = content.some((part: unknown) => record(part) && part.type === 'image' && record(part.source)
    && part.source.type === 'base64' && part.source.data === file.base64 && part.source.media_type === file.type);
  if (!correlated) return value;
  // Native Read repeats its image bytes in structured output; only the resource reader carries them.
  const { base64: _bytes, ...metadata } = file;
  return { ...value, file: metadata };
}

function toolResultJson(value: unknown): AgentToolResultJson | undefined {
  if (value === undefined) return;
  try {
    return JSON.parse(JSON.stringify(value, (_key, entry: unknown) => {
      if (typeof entry === 'number' && !Number.isFinite(entry)
        || !['string', 'number', 'boolean', 'object'].includes(typeof entry)) throw new Error('Non-JSON tool result.');
      return entry;
    })) as AgentToolResultJson;
  } catch { return; }
}
