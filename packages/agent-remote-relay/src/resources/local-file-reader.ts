import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectMediaType } from './media-type.js';

import type { AgentResourceReadResult } from '@orchardworks/agent-provider-sdk';

export const DEFAULT_MAX_LOCAL_RESOURCE_BYTES = 4 * 1024 * 1024;

export const DEFAULT_MAX_LOCAL_TEXT_BYTES = 1024 * 1024;

export interface LocalFileResourceReader {
  read(locator: string, sourceLocator?: string): Promise<AgentResourceReadResult>;
}

export interface LocalFileResourceReaderOptions {
  roots: readonly string[];
  maxBytes?: number;
}

export async function createLocalFileResourceReader(
  options: LocalFileResourceReaderOptions,
): Promise<LocalFileResourceReader> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_LOCAL_RESOURCE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Local resource byte limit must be positive.');
  const roots = [...new Set(await Promise.all(options.roots.map((root) => realpath(root))))];
  if (roots.length === 0) throw new Error('At least one local resource root is required.');

  return {
    async read(locator, sourceLocator) {
      const candidate = localPath(locator, sourceLocator, roots);
      if (!candidate) return unavailable('Local resource locator is not permitted.');
      let canonical: string;
      try {
        canonical = await realpath(candidate);
      } catch {
        return unavailable('Local resource does not exist.');
      }
      if (!roots.some((root) => contains(root, canonical))) {
        return unavailable('Local resource is outside the authorized roots.');
      }

      let handle;
      try {
        const expected = await stat(canonical);
        if (!expected.isFile()) return unavailable('Local resource is not a regular file.');
        handle = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
        const opened = await handle.stat();
        if (!opened.isFile()) return unavailable('Local resource is not a regular file.');
        if (opened.dev !== expected.dev || opened.ino !== expected.ino) return unavailable('Local resource changed while it was opened.');
        if (opened.size === 0) return unavailable('Local resource is empty.');
        if (opened.size > maxBytes) return unavailable('Local resource exceeds the configured byte limit.');
        const buffer = new Uint8Array(maxBytes + 1);
        let length = 0;
        while (length <= maxBytes) {
          const result = await handle.read(buffer, length, buffer.byteLength - length, null);
          if (result.bytesRead === 0) break;
          length += result.bytesRead;
        }
        if (length !== opened.size || length > maxBytes) {
          return unavailable('Local resource changed while it was read.');
        }
        const bytes = buffer.slice(0, length);
        const mediaType = detectMediaType(bytes);
        const image = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mediaType);
        if (!image) {
          if (!['text/plain', 'text/html', 'image/svg+xml', 'application/json'].includes(mediaType) || bytes.includes(0)) {
            return unavailable('Local resource is not a supported image or UTF-8 text file.');
          }
          if (bytes.byteLength > DEFAULT_MAX_LOCAL_TEXT_BYTES) return unavailable('Text preview exceeds the 1 MiB limit.');
        }
        return { status: 'available', bytes, mediaType };
      } catch {
        return unavailable('Local resource could not be read.');
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },
  };
}

function localPath(locator: string, sourceLocator: string | undefined, roots: readonly string[]): string | undefined {
  if (!locator || locator.includes('\0') || locator.startsWith('//')) return undefined;
  let path: string;
  try {
    path = locator.startsWith('file:') ? fileURLToPath(new URL(locator)) : decodeURI(locator);
  } catch {
    return undefined;
  }
  if (path.includes('\0')) return undefined;
  if (/^[a-z][a-z\d+.-]*:/i.test(path)) return undefined;
  if (isAbsolute(path)) return path;

  const sourcePath = sourceLocator ? localSourcePath(sourceLocator) : undefined;
  if (sourceLocator && !sourcePath) return undefined;
  const base = sourcePath ? dirname(sourcePath) : roots[0]!;
  return resolve(base, path);
}

function localSourcePath(locator: string): string | undefined {
  try {
    if (locator.startsWith('file:')) return fileURLToPath(new URL(locator));
  } catch {
    return undefined;
  }
  return isAbsolute(locator) ? locator : undefined;
}

function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function unavailable(reason: string): AgentResourceReadResult {
  return { status: 'unavailable', reason };
}
