import { boundToolResult, type AgentUserMessagePart, type ProviderResourceReference, type AgentToolResultJson, type AgentStreamEvent, type AgentTimelineItem, type AgentToolDetail, type ProviderObservation } from '@orchardworks/agent-provider-sdk';
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

/** Converts native transcript and streaming frames to append-only normalized observations. */
export class ClaudeEventProjector {
  private readonly seen = new Set<string>();
  private readonly blocks = new Map<string, Block[]>();
  private readonly tools = new Map<string, { name: string; detail: AgentToolDetail }>();
  private activeMessage = '';
  private sequence = 0;

  constructor(private readonly sessionId: string, private readonly delivery: 'history' | 'live' = 'live', private readonly images = new ClaudeImageRegistry(sessionId)) {}

  project(value: unknown): ProviderObservation[] {
    if (!record(value) || value.parent_tool_use_id || value.session_id && value.session_id !== this.sessionId) return [];
    if (value.type === 'stream_event') return this.stream(value.event);
    if (typeof value.uuid === 'string') {
      if (this.seen.has(value.uuid)) return [];
      this.seen.add(value.uuid);
    }
    const key = `message:${value.uuid ?? ++this.sequence}`;
    if (value.type === 'system' && value.subtype === 'compact_boundary') {
      return [this.item(key, { type: 'compaction', status: 'completed',
        ...(record(value.compact_metadata) ? { trigger: value.compact_metadata.trigger, preTokens: value.compact_metadata.pre_tokens } : {}) })];
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
        if (block.type === 'text' && typeof block.text === 'string') parts.push({ type: 'text', text: block.text });
        else if (block.type === 'image') {
          const image = this.images.projectUser(key, index, block, `image #${++imageIndex}`);
          parts.push(image.part);
          resourceReferences.push(...image.resourceReferences);
        }
      }
      const text = parts.map(part => part.type === 'text' ? part.text : `[${part.label}]`).join(imageIndex ? '' : '\n');
      if (text && !value.isSynthetic) events.push({ ...this.item(key, { type: 'user_message', text, messageId: value.uuid,
        ...(imageIndex ? { content: parts } : {}) }), ...(imageIndex ? { resourceReferences } : {}) });
      const toolResults = content.filter((block: unknown) => record(block) && block.type === 'tool_result');
      const structured = toolResults.length === 1 ? toolResultJson(imageMetadata(value.tool_use_result, toolResults[0].content)) : undefined;
      for (const block of toolResults) {
        const tool = this.tools.get(block.tool_use_id) ?? { name: 'Tool', detail: { type: 'other', description: 'Native tool result' } as const };
        const output = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
          ? block.content.filter((part: unknown) => record(part) && part.type === 'text').map((part: any) => part.text).join('\n') : '';
        const result = boundToolResult({ content: [{ type: 'text', text: output },
          ...(structured === undefined ? [] : [{ type: 'json' as const, value: structured }])] });
        events.push(this.item(`${key}:tool:${block.tool_use_id}`, { type: 'tool_call', callId: block.tool_use_id, ...tool, result,
          ...(block.is_error ? { status: 'failed' as const, error: output.slice(0, 1024) || 'Tool failed' } : { status: 'completed' as const, error: null }) }));
        if (typeof block.tool_use_id === 'string' && Array.isArray(block.content)) {
          for (const [index, part] of block.content.entries()) {
            const image = this.images?.project(block.tool_use_id, index, part);
            if (image) events.push({ ...this.item(`${key}:tool:${block.tool_use_id}:image:${index}`, image.item), resourceReferences: image.resourceReferences });
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
        const suffix = text.startsWith(current.text) ? text.slice(current.text.length) : text;
        current.text = text;
        if (suffix) events.push(this.item(blockKey, block.type === 'thinking' ? { type: 'reasoning', text: suffix }
          : { type: 'assistant_message', messageId: `${messageId}:${current.index}`, text: suffix }));
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        const input = record(block.input) ? block.input : {};
        const tool = { name: block.name, detail: toolDetail(block.name, input) };
        this.tools.set(block.id, tool);
        events.push(this.item(blockKey, { type: 'tool_call', callId: block.id, ...tool, status: 'running', error: null }));
        if (block.name === 'TodoWrite' && Array.isArray(input.todos)) events.push(this.item(`${blockKey}:todo`, { type: 'todo',
          items: input.todos.filter((todo: unknown) => record(todo) && typeof todo.content === 'string').map((todo: any) => ({ text: todo.content,
            completed: todo.status === 'completed', ...( ['pending', 'in_progress', 'completed'].includes(todo.status) ? { status: todo.status } : {}) })) }));
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
      if (!current || !['text_delta', 'thinking_delta'].includes(value.delta.type)) return [];
      return this.delta(current, value.delta.type === 'thinking_delta' ? value.delta.thinking : value.delta.text);
    }
    return [];
  }

  private delta(block: Block, text: unknown): ProviderObservation[] {
    if (typeof text !== 'string' || !text) return [];
    block.text += text;
    return [this.item(`stream:${this.activeMessage}:${block.index}:${block.text.length}`, block.type === 'thinking'
      ? { type: 'reasoning', text } : { type: 'assistant_message', messageId: `${this.activeMessage}:${block.index}`, text })];
  }

  private item(key: string, item: AgentTimelineItem): ProviderObservation {
    return this.observation(key, { type: 'timeline', provider: 'claude', item });
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
