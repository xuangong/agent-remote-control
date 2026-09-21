import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { AgentResourceReadResult, AgentTimelineItem, AgentUserMessagePart, ProviderResourceReference } from '@orchardworks/agent-provider-sdk';

interface ImageProjection {
  item: Extract<AgentTimelineItem, { type: 'assistant_message' }>;
  resourceReferences: ProviderResourceReference[];
}
interface ImageLimits { maxImageBytes: number; maxSessionImageBytes: number; maxImages: number }
interface ImageEntry { projection: ImageProjection; bytes: Buffer; mediaType: string }
const defaults: ImageLimits = { maxImageBytes: 16 * 1024 * 1024, maxSessionImageBytes: 64 * 1024 * 1024, maxImages: 1024 };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Owns only embedded raster bytes explicitly carried by this session's native tool results. */
export class ClaudeImageRegistry {
  private readonly entries = new Map<string, ImageEntry>();
  private readonly limits: ImageLimits;
  private retainedBytes = 0;
  private active = true;

  constructor(private readonly sessionId: string, limits: Partial<ImageLimits> = {}) {
    this.limits = { ...defaults, ...limits };
  }

  project(toolUseId: string, index: number, image: unknown): ImageProjection | null {
    if (!this.active || !toolUseId || !record(image) || image.type !== 'image') return null;
    const locator = `claude-image:${createHash('sha256').update(JSON.stringify([this.sessionId, toolUseId, index])).digest('hex')}`;
    const existing = this.entries.get(locator);
    if (existing) return cloneProjection(existing.projection);
    const unavailable = (reason: string): ImageProjection => ({
      item: { type: 'assistant_message', messageId: locator, text: `Tool image unavailable: ${reason}` }, resourceReferences: [],
    });
    const source = image.source;
    if (!record(source) || source.type !== 'base64' || typeof source.data !== 'string') return unavailable('Native result has no embedded image bytes.');
    if (this.entries.size >= this.limits.maxImages) return unavailable('Session image count exceeds the configured limit.');
    const encoded = source.data;
    if (encoded.length > Math.ceil(this.limits.maxImageBytes / 3) * 4) return unavailable('Native image exceeds the configured byte limit.');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return unavailable('Native image contains invalid base64 data.');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > this.limits.maxImageBytes || bytes.toString('base64') !== encoded) return unavailable('Native image contains invalid or oversized base64 data.');
    const mediaType = rasterMediaType(bytes);
    if (!mediaType || mediaType !== source.media_type) return unavailable('Native image is not a matching supported raster image.');
    if (this.retainedBytes + bytes.length > this.limits.maxSessionImageBytes) return unavailable('Session image storage exceeds the configured byte limit.');
    const projection: ImageProjection = { item: { type: 'assistant_message', messageId: locator, text: `![Tool image](${locator})` },
      resourceReferences: [{ locator, readLocator: locator }] };
    this.retainedBytes += bytes.length;
    this.entries.set(locator, { projection, bytes, mediaType });
    return cloneProjection(projection);
  }

  projectUser(messageId: string, index: number, image: unknown, label: string): {
    part: AgentUserMessagePart; resourceReferences: ProviderResourceReference[];
  } {
    const identity = `user:${messageId}`;
    const projection = this.project(identity, index, image);
    const locator = `claude-image:${createHash('sha256').update(JSON.stringify([this.sessionId, identity, index])).digest('hex')}`;
    const entry = this.entries.get(locator);
    return { part: { type: 'image', locator, label,
      ...(entry ? { sha256: createHash('sha256').update(entry.bytes).digest('hex') } : {}) },
      resourceReferences: projection?.resourceReferences ?? [] };
  }

  async readResource(locator: string): Promise<AgentResourceReadResult> {
    if (!this.active) return { status: 'unavailable', reason: 'Claude image reader is stopped.' };
    const entry = this.entries.get(locator);
    return entry ? { status: 'available', bytes: Buffer.from(entry.bytes), mediaType: entry.mediaType }
      : { status: 'unavailable', reason: 'Resource is not a native image owned by this Claude session.' };
  }

  stop(): void { this.active = false; this.entries.clear(); this.retainedBytes = 0; }
}

function cloneProjection(projection: ImageProjection): ImageProjection {
  return { item: { ...projection.item }, resourceReferences: projection.resourceReferences.map((reference) => ({ ...reference })) };
}

function rasterMediaType(bytes: Buffer): string | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 13 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0) return 'image/gif';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}
