import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { IMAGE_INPUT_CAPABILITIES, type AgentInputPart, type AgentResourceReadResult, type AgentUserMessagePart, type ProviderResourceReference } from '@orchardworks/agent-provider-sdk';
import type { FilePartInput, Part, TextPartInput } from '@opencode-ai/sdk/v2/client';

function mediaType(bytes: Buffer): string | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
}
const unavailable = (): AgentResourceReadResult => ({ status: 'unavailable', reason: 'Only bounded native inline images are available.' });
export class OpenCodeImages {
  private readonly resources = new Map<string, AgentResourceReadResult>();
  private totalBytes = 0;
  constructor(private readonly sessionId: string) {}
  project(messageId: string, parts: Part[]): { content: AgentUserMessagePart[]; references: ProviderResourceReference[] } {
    const content: AgentUserMessagePart[] = [];
    const references: ProviderResourceReference[] = [];
    for (const part of parts) {
      if (part.type !== 'file' || !part.mime.startsWith('image/')) continue;
      const locator = `opencode-image:${createHash('sha256').update(JSON.stringify([this.sessionId, messageId, part.id])).digest('hex')}`;
      if (!this.resources.has(locator)) {
        const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(part.url);
        let resource = unavailable();
        if (match && match[1] === part.mime && match[2]!.length <= Math.ceil(IMAGE_INPUT_CAPABILITIES.maxImageBytes / 3) * 4) {
          const bytes = Buffer.from(match[2]!, 'base64');
          if (bytes.length <= IMAGE_INPUT_CAPABILITIES.maxImageBytes && bytes.length + this.totalBytes <= 64 * 1024 * 1024 && mediaType(bytes) === part.mime && bytes.toString('base64') === match[2]) {
            resource = { status: 'available', bytes, mediaType: part.mime }; this.totalBytes += bytes.length;
          }
        }
        this.resources.set(locator, resource);
      }
      content.push({ type: 'image', locator, label: part.filename ?? 'Image' });
      references.push({ locator, readLocator: locator });
    }
    return { content, references };
  }
  async read(locator: string): Promise<AgentResourceReadResult> {
    const resource = this.resources.get(locator) ?? unavailable();
    return resource.status === 'available' ? { ...resource, bytes: Uint8Array.from(resource.bytes) } : resource;
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
  close(): void { this.resources.clear(); this.totalBytes = 0; }
}
