import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { AgentResourceReadResult, AgentTimelineItem, ProviderResourceReference } from '@borgee/agent-provider-sdk';

import { isRecord, readString } from './native.js';

const maxImageBytes = 16 * 1024 * 1024;
const maxSessionImageBytes = 64 * 1024 * 1024;

export interface CodexImageProjection {
  item: Extract<AgentTimelineItem, { type: 'assistant_message' }>;
  resourceReferences: ProviderResourceReference[];
}

type ImageSource = { path: string } | { data: string } | { unavailable: string };
interface ImageEntry {
  projection: CodexImageProjection;
  source: ImageSource;
  materialized?: Promise<AgentResourceReadResult>;
}

/** Resolves only image sources explicitly named by this session's native image items. */
export class CodexImageRegistry {
  private readonly entries = new Map<string, ImageEntry>();
  private retainedBytes = 0;
  private registeredDataBytes = 0;
  private active = true;

  constructor(private readonly sessionId: string) {}

  project(item: unknown, cwd?: string): CodexImageProjection | null {
    if (!this.active || !isRecord(item) || (item.type !== 'imageView' && item.type !== 'imageGeneration')) return null;
    const id = readString(item.id);
    if (!id) return null;
    const locator = `codex-image:${createHash('sha256').update(this.sessionId).update('\0').update(id).digest('hex')}`;
    const existing = this.entries.get(locator);
    if (existing) return cloneProjection(existing.projection);
    let source = imageSource(item, cwd);
    if ('data' in source) {
      const byteLength = Buffer.byteLength(source.data);
      if (byteLength > Math.ceil(maxImageBytes / 3) * 4 + 128 || this.registeredDataBytes + byteLength > maxSessionImageBytes) {
        source = { unavailable: 'Native image data exceeds the configured byte limit.' };
      } else {
        this.registeredDataBytes += byteLength;
      }
    }
    const label = item.type === 'imageView' ? 'Viewed image' : 'Generated image';
    const projection: CodexImageProjection = {
      item: {
        type: 'assistant_message', messageId: id,
        text: 'unavailable' in source ? `${label} unavailable: ${source.unavailable}` : `![${label}](${locator})`,
      },
      resourceReferences: 'unavailable' in source ? [] : [{ locator, readLocator: locator }],
    };
    this.entries.set(locator, { source, projection });
    return cloneProjection(projection);
  }

  async readResource(locator: string): Promise<AgentResourceReadResult> {
    if (!this.active) return unavailable('Codex image reader is stopped.');
    const entry = this.entries.get(locator);
    if (!entry) return unavailable('Resource is not a native image owned by this Codex session.');
    entry.materialized ??= this.materialize(entry.source);
    const result = await entry.materialized;
    return result.status === 'available' ? { ...result, bytes: Buffer.from(result.bytes) } : { ...result };
  }

  stop(): void {
    this.active = false;
    this.entries.clear();
    this.retainedBytes = 0;
    this.registeredDataBytes = 0;
  }

  private async materialize(source: ImageSource): Promise<AgentResourceReadResult> {
    if ('unavailable' in source) return unavailable(source.unavailable);
    try {
      const bytes = 'path' in source ? await readImageFile(source.path) : decodeImageData(source.data);
      const mediaType = rasterMediaType(bytes);
      if (!mediaType) return unavailable('Native image is not a supported raster image.');
      if (!this.active) return unavailable('Codex image reader is stopped.');
      if (this.retainedBytes + bytes.length > maxSessionImageBytes) return unavailable('Session image storage exceeds the configured byte limit.');
      this.retainedBytes += bytes.length;
      return { status: 'available', bytes, mediaType };
    } catch (error) {
      return unavailable(error instanceof ImageReadError ? error.message : 'Native image file is unavailable.');
    }
  }
}

function cloneProjection(projection: CodexImageProjection): CodexImageProjection {
  return { item: { ...projection.item }, resourceReferences: projection.resourceReferences.map((reference) => ({ ...reference })) };
}

function unavailable(reason: string): AgentResourceReadResult {
  return { status: 'unavailable', reason };
}

class ImageReadError extends Error {}

function imageSource(item: Record<string, unknown>, cwd?: string): ImageSource {
  if (item.type === 'imageView') return pathSource(readString(item.path), cwd);
  if (item.status === 'failed' || item.failure != null) return { unavailable: 'Native image generation failed.' };
  const savedPath = readString(item.savedPath) ?? readString(item.saved_path);
  if (savedPath) return pathSource(savedPath, cwd);
  const result = item.result;
  if (isRecord(result)) {
    const path = readString(result.path) ?? readString(result.savedPath) ?? readString(result.saved_path);
    if (path) return pathSource(path, cwd);
    const data = readString(result.data);
    if (data) return { data };
    return { unavailable: 'Native image result has no local file or embedded image data.' };
  }
  if (typeof result !== 'string' || !result.trim()) return { unavailable: 'Native image result is empty.' };
  const value = result.trim();
  if (/^data:/i.test(value)) return { data: value };
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)
    && (rasterMediaType(Buffer.from(value.slice(0, 64), 'base64')) || (!isAbsolute(value) && value.length > 64))) return { data: value };
  return pathSource(value, cwd);
}

function pathSource(path: string | undefined, cwd?: string): ImageSource {
  if (!path || path.includes('\0') || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    return { unavailable: 'Native image has no supported local file path.' };
  }
  if (!isAbsolute(path) && (!cwd || !isAbsolute(cwd))) return { unavailable: 'Relative native image path has no absolute session working directory.' };
  return { path: isAbsolute(path) ? path : resolve(cwd!, path) };
}

async function readImageFile(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new ImageReadError('Native image path is not a regular file.');
    if (stat.size < 1 || stat.size > maxImageBytes) throw new ImageReadError('Native image exceeds the configured byte limit or is empty.');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset !== stat.size) throw new ImageReadError('Native image changed while being read.');
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

function decodeImageData(value: string): Buffer {
  if (value.length > Math.ceil(maxImageBytes / 3) * 4 + 128) throw new ImageReadError('Native image exceeds the configured byte limit.');
  let encoded = value;
  if (/^data:/i.test(value)) {
    const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
    if (!match) throw new ImageReadError('Native image data URL is not a supported raster image.');
    encoded = match[1]!;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new ImageReadError('Native image contains invalid base64 data.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 1 || bytes.length > maxImageBytes) throw new ImageReadError('Native image exceeds the configured byte limit or is empty.');
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new ImageReadError('Native image contains invalid base64 data.');
  return bytes;
}

function rasterMediaType(bytes: Buffer): string | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 13 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0) return 'image/gif';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}
