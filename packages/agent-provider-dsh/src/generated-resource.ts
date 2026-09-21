import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { posix } from 'node:path';

import type { AgentResourceReadResult } from '@orchardworks/agent-provider-sdk';

import {
  dshProviderSourceKey,
  isRecord,
  nativeEvent,
  nonEmptyString,
  type DshNativeObservation,
} from './native.js';

const maxResourceBytes = 16 * 1024 * 1024;

export class DshGeneratedResourceReader {
  private active = true;

  constructor(
    private readonly sessionId: string,
    private readonly observations: () => readonly DshNativeObservation[],
  ) {}

  reference(locator: string, revisionKey: string): string | undefined {
    const normalized = normalizeGeneratedResourceLocator(locator);
    if (!normalized) return undefined;
    return generatedResourceReadLocator(this.sessionId, revisionKey, normalized);
  }

  stop(): void {
    this.active = false;
  }

  async read(locator: string): Promise<AgentResourceReadResult> {
    if (!this.active) return { status: 'unavailable', reason: 'DSH generated-resource reader is stopped.' };
    const exact = isGeneratedResourceReadLocator(locator) ? locator : undefined;
    const normalized = exact ? undefined : normalizeGeneratedResourceLocator(locator);
    if (!exact && !normalized) return missingGeneratedResource();

    const pendingWrites = new Map<string, string>();
    let latestContent: string | undefined;
    for (const observation of this.observations()) {
      if (observation.kind !== 'session_event') continue;
      const native = nativeEvent(observation);
      if (!native.type || !native.data) continue;
      if (native.type === 'tool/call') {
        const callId = nonEmptyString(native.data.callId);
        if (callId && native.data.name === 'write' && typeof native.data.arguments === 'string') {
          pendingWrites.set(callId, native.data.arguments);
        }
        continue;
      }
      if (native.type !== 'tool/result') continue;
      const message = isRecord(native.data.message) ? native.data.message : undefined;
      const source = isRecord(message?.source) ? message.source : undefined;
      const callId = nonEmptyString(native.data.callId) ?? nonEmptyString(source?.callId);
      if (!callId) continue;
      const rawArguments = pendingWrites.get(callId);
      pendingWrites.delete(callId);
      if (rawArguments === undefined || failedToolResult(native.data, message)) continue;
      const write = readWriteArguments(rawArguments);
      if (!write) continue;
      const readLocator = generatedResourceReadLocator(
        this.sessionId,
        dshProviderSourceKey(this.sessionId, observation),
        write.locator,
      );
      if (exact === readLocator) return generatedResourceOutcome(write.content);
      if (normalized === write.locator) latestContent = write.content;
    }
    return latestContent === undefined ? missingGeneratedResource() : generatedResourceOutcome(latestContent);
  }
}

function readWriteArguments(raw: string): { locator: string; content: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.content !== 'string') return undefined;
  const locator = normalizeGeneratedResourceLocator(nonEmptyString(parsed.file_path) ?? nonEmptyString(parsed.path) ?? '');
  return locator ? { locator, content: parsed.content } : undefined;
}

function failedToolResult(data: Record<string, unknown>, message: Record<string, unknown> | undefined): boolean {
  const first = Array.isArray(message?.content) && isRecord(message.content[0]) ? message.content[0] : undefined;
  return first?.isError === true || data.isError === true || data.error !== undefined;
}

function generatedResourceOutcome(content: string): AgentResourceReadResult {
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength < 1) return { status: 'unavailable', reason: 'Generated resource is empty.' };
  if (byteLength > maxResourceBytes) {
    return { status: 'unavailable', reason: 'Generated resource exceeds the configured byte limit.' };
  }
  const bytes = new TextEncoder().encode(content);
  return { status: 'available', bytes, mediaType: detectMediaType(bytes) };
}

function missingGeneratedResource(): AgentResourceReadResult {
  return {
    status: 'unavailable',
    reason: 'Resource is not a successful generated file owned by this DSH session.',
  };
}

function isGeneratedResourceReadLocator(locator: string): boolean {
  return /^dsh-generated:[a-f0-9]{64}$/.test(locator);
}

function generatedResourceReadLocator(sessionId: string, revisionKey: string, normalizedLocator: string): string {
  const digest = createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(revisionKey)
    .update('\0')
    .update(normalizedLocator)
    .digest('hex');
  return `dsh-generated:${digest}`;
}

export function normalizeGeneratedResourceLocator(locator: string): string | undefined {
  const trimmed = locator.trim();
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('\\') || isAbsolute(trimmed) || posix.isAbsolute(trimmed)) {
    return undefined;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return undefined;
  if (trimmed.split('/').some((segment) => segment === '..')) return undefined;
  const normalized = posix.normalize(trimmed);
  if (normalized === '.' || normalized.startsWith('../')) return undefined;
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function detectMediaType(bytes: Uint8Array): string {
  if (startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (startsWith(bytes, [255, 216, 255])) return 'image/jpeg';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (startsWith(bytes, [80, 75, 3, 4])) return 'application/zip';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'text/plain';
  } catch {
    return 'application/octet-stream';
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}
