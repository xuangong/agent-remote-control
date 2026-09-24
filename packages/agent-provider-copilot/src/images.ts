import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {IMAGE_INPUT_CAPABILITIES, type ImageInputCapabilities, type AgentInputPart, type AgentResourceReadResult, type AgentUserMessagePart, type ProviderResourceReference} from '@orchardworks/agent-provider-sdk';
import {record} from './native.js';

function mediaType(bytes: Buffer): string | undefined {
 if (bytes.length >= 24 && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
 if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
 if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
}
const unavailable = (): AgentResourceReadResult => ({status: 'unavailable', reason: 'Native image bytes are unavailable or exceed the image limits.'});
/** Only native inline attachments are readable; paths and asset IDs are not filesystem authority. */
export class CopilotImages {
 private readonly resources = new Map<string, AgentResourceReadResult>();
 private bytes = 0;
 private readonly assets = new Map<string, AgentResourceReadResult>();
 constructor(private readonly sessionId: string) {}
 register(asset: unknown): void {
  const a = record(asset); if (typeof a.assetId !== 'string' || this.assets.has(a.assetId)) return;
  const result = this.decode(a);
  if (result.status === 'available' && (a.byteLength !== result.bytes.length || a.assetId !== `sha256:${createHash('sha256').update(result.bytes).digest('hex')}`)) {
   this.bytes -= result.bytes.length; this.assets.set(a.assetId, unavailable()); return;
  }
  this.assets.set(a.assetId, result);
 }
 private decode(a: Record<string, unknown>): AgentResourceReadResult {
  if (typeof a.data !== 'string' || a.data.length > Math.ceil(IMAGE_INPUT_CAPABILITIES.maxImageBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data)) return unavailable();
  const bytes = Buffer.from(a.data, 'base64');
  if (bytes.length > IMAGE_INPUT_CAPABILITIES.maxImageBytes || this.bytes + bytes.length > 64 * 1024 * 1024 || mediaType(bytes) !== a.mimeType || bytes.toString('base64').replace(/=+$/, '') !== a.data.replace(/=+$/, '')) return unavailable();
  this.bytes += bytes.length; return {status: 'available', bytes, mediaType: a.mimeType as string};
 }
 project(messageId: string, text: string, attachments: readonly unknown[]): {content: AgentUserMessagePart[]; resourceReferences: ProviderResourceReference[]} {
  const content: AgentUserMessagePart[] = text ? [{type: 'text', text}] : [];
  const resourceReferences: ProviderResourceReference[] = [];
  attachments.forEach((attachment, index) => {
   const a = record(attachment);
   if (a.type !== 'blob' || !['image/png', 'image/jpeg', 'image/webp'].includes(String(a.mimeType))) return;
   const locator = `copilot-image:${createHash('sha256').update(JSON.stringify([this.sessionId, messageId, index])).digest('hex')}`;
   if (!this.resources.has(locator)) {
    const result = typeof a.data === 'string' ? this.decode(a) : typeof a.assetId === 'string' ? this.assets.get(a.assetId) ?? unavailable() : unavailable();
    this.resources.set(locator, result);
   }
   const result = this.resources.get(locator)!;
   content.push({type: 'image', locator, label: typeof a.displayName === 'string' ? a.displayName : 'Image', ...(result.status === 'available' ? {sha256: createHash('sha256').update(result.bytes).digest('hex')} : {})});
   resourceReferences.push({locator, readLocator: locator});
  });
  return {content, resourceReferences};
 }
 async read(locator: string): Promise<AgentResourceReadResult> {
  const result = this.resources.get(locator) ?? unavailable();
  return result.status === 'available' ? {...result, bytes: Buffer.from(result.bytes)} : {...result};
 }
 async input(parts: readonly AgentInputPart[], limits: ImageInputCapabilities = IMAGE_INPUT_CAPABILITIES) {
  const attachments: {type: 'blob'; data: string; mimeType: string; displayName: string}[] = [];
  const prompt = parts.flatMap(p => p.type === 'text' ? [p.text] : []).join('\n');
  let total = Buffer.byteLength(prompt);
  for (const part of parts) {
   if (part.type !== 'image') continue;
   if (attachments.length >= limits.maxImages) throw new Error('Too many Copilot image attachments.');
   if (!limits.mediaTypes.includes(part.mediaType)) throw new Error('Unsupported Copilot image type.');
   const file = await open(part.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
   let bytes: Buffer;
   try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limits.maxImageBytes) throw new Error('Invalid Copilot image file.');
    const buffer = Buffer.alloc(limits.maxImageBytes + 1); let length = 0;
    while (length < buffer.length) {const r = await file.read(buffer, length, buffer.length - length, null); if (!r.bytesRead) break; length += r.bytesRead;}
    bytes = buffer.subarray(0, length);
   } finally {await file.close();}
   total += bytes.length;
   if (bytes.length > limits.maxImageBytes || total > limits.maxMessageBytes || mediaType(bytes) !== part.mediaType || createHash('sha256').update(bytes).digest('hex') !== part.sha256) throw new Error('Copilot image content failed validation.');
   attachments.push({type: 'blob', data: bytes.toString('base64'), mimeType: part.mediaType, displayName: part.label});
  }
  return {prompt, attachments};
 }
 stop(): void {this.resources.clear(); this.assets.clear(); this.bytes = 0;}
}
