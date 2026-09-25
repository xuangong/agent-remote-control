import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { IMAGE_INPUT_CAPABILITIES, type AgentInputPart, type AgentResourceReadResult, type AgentUserMessagePart, type ProviderResourceReference } from '@orchardworks/agent-provider-sdk';
import type { FilePartInput, Part, TextPartInput } from '@opencode-ai/sdk/v2/client';

function mediaType(bytes: Buffer): string | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 13 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0) return 'image/gif';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
}
const unavailable = (): AgentResourceReadResult => ({ status: 'unavailable', reason: 'Native image is unavailable or exceeds the supported resource limits.' });
interface ImageEntry {
  resource?: AgentResourceReadResult;
  path?: string;
  mime: string;
  materialized?: Promise<AgentResourceReadResult>;
}
export class OpenCodeImages {
  private readonly resources = new Map<string, ImageEntry>();
  private totalBytes = 0;
  private active = true;
  constructor(private readonly sessionId: string, private readonly options: { allowLocalFiles?: boolean } = {}) {}
  project(messageId: string, parts: Part[]): { content: AgentUserMessagePart[]; references: ProviderResourceReference[] } {
    const content: AgentUserMessagePart[] = [];
    const references: ProviderResourceReference[] = [];
    if (!this.active) return { content, references };
    for (const part of parts) {
      if (part.type !== 'file' || !part.mime.startsWith('image/') || part.sessionID !== this.sessionId || part.messageID !== messageId) continue;
      const locator = `opencode-image:${createHash('sha256').update(JSON.stringify([this.sessionId, messageId, part.id])).digest('hex')}`;
      if (!this.resources.has(locator)) {
        const entry: ImageEntry = { mime: part.mime };
        const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(part.url);
        if (match && match[1] === part.mime && match[2]!.length <= Math.ceil(IMAGE_INPUT_CAPABILITIES.maxImageBytes / 3) * 4) {
          const bytes = Buffer.from(match[2]!, 'base64');
          if (bytes.toString('base64') === match[2]) entry.resource = this.retain(bytes, part.mime);
        } else if (this.options.allowLocalFiles && part.url.startsWith('file:')) {
          try {
            const url = new URL(part.url);
            if ((!url.hostname || url.hostname === 'localhost') && !url.search && !url.hash) entry.path = fileURLToPath(url);
          } catch { /* Invalid native file URLs remain unavailable. */ }
        }
        if (!entry.path && !entry.resource) entry.resource = unavailable();
        this.resources.set(locator, entry);
      }
      content.push({ type: 'image', locator, label: part.filename ?? 'Image' });
      references.push({ locator, readLocator: locator });
    }
    return { content, references };
  }
  private retain(bytes: Buffer, mime: string): AgentResourceReadResult {
    if (!this.active || bytes.length > IMAGE_INPUT_CAPABILITIES.maxImageBytes || bytes.length + this.totalBytes > 64 * 1024 * 1024 || mediaType(bytes) !== mime) return unavailable();
    this.totalBytes += bytes.length;
    return { status: 'available', bytes, mediaType: mime };
  }
  private async materialize(entry: ImageEntry): Promise<AgentResourceReadResult> {
    if (entry.resource) return entry.resource;
    if (!entry.path || !this.active) return unavailable();
    try {
      const file = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > IMAGE_INPUT_CAPABILITIES.maxImageBytes) return unavailable();
        const bytes = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await file.read(bytes, length, bytes.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length !== stat.size) return unavailable();
        return this.retain(bytes.subarray(0, length), entry.mime);
      } finally { await file.close(); }
    } catch { return unavailable(); }
  }
  async read(locator: string): Promise<AgentResourceReadResult> {
    if (!this.active) return unavailable();
    const entry = this.resources.get(locator);
    if (!entry) return unavailable();
    entry.materialized ??= this.materialize(entry);
    const resource = await entry.materialized;
    if (!this.active) return unavailable();
    return resource.status === 'available' ? { ...resource, bytes: Uint8Array.from(resource.bytes) } : { ...resource };
  }
  async input(parts: readonly AgentInputPart[]): Promise<Array<TextPartInput | FilePartInput>> {
    const result: Array<TextPartInput | FilePartInput> = [];
    let total = 0; let count = 0;
    for (const part of parts) {
      if (part.type === 'text') { total += Buffer.byteLength(part.text); result.push({ type: 'text', text: part.text }); continue; }
      if (++count > IMAGE_INPUT_CAPABILITIES.maxImages || !IMAGE_INPUT_CAPABILITIES.mediaTypes.includes(part.mediaType)) throw new Error('Unsupported OpenCode image input.');
      const file = await open(part.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > IMAGE_INPUT_CAPABILITIES.maxImageBytes) throw new Error('Invalid OpenCode image file.');
        const buffer = Buffer.alloc(IMAGE_INPUT_CAPABILITIES.maxImageBytes + 1); let length = 0;
        while (length < buffer.length) { const read = await file.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
        bytes = buffer.subarray(0, length);
      } finally { await file.close(); }
      if (bytes.length > IMAGE_INPUT_CAPABILITIES.maxImageBytes || mediaType(bytes) !== part.mediaType || createHash('sha256').update(bytes).digest('hex') !== part.sha256) throw new Error('OpenCode image content failed validation.');
      total += bytes.length;
      result.push({ type: 'file', mime: part.mediaType, filename: part.label, url: `data:${part.mediaType};base64,${bytes.toString('base64')}` });
    }
    if (total > IMAGE_INPUT_CAPABILITIES.maxMessageBytes) throw new Error('OpenCode input exceeds the message size limit.');
    return result;
  }
  close(): void { this.active = false; this.resources.clear(); this.totalBytes = 0; }
}
