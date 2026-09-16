import { open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentResourceReadResult } from '@agent-remote-controller/agent-provider-sdk';

import { DEFAULT_MAX_RESOURCE_BYTES } from './resource-ingestor.js';

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
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESOURCE_BYTES;
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
        handle = await open(canonical, 'r');
        const stat = await handle.stat();
        if (!stat.isFile()) return unavailable('Local resource is not a regular file.');
        if (stat.size === 0) return unavailable('Local resource is empty.');
        if (stat.size > maxBytes) return unavailable('Local resource exceeds the configured byte limit.');
        const bytes = new Uint8Array(await handle.readFile());
        if (bytes.byteLength !== stat.size || bytes.byteLength > maxBytes) {
          return unavailable('Local resource changed while it was read.');
        }
        const mediaType = rasterMediaType(bytes);
        return mediaType
          ? { status: 'available', bytes, mediaType }
          : unavailable('Local resource is not a supported raster image.');
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
    path = locator.startsWith('file:') ? fileURLToPath(new URL(locator)) : locator;
  } catch {
    return undefined;
  }
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

function rasterMediaType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (startsWith(bytes, [255, 216, 255])) return 'image/jpeg';
  const header = String.fromCharCode(...bytes.slice(0, 12));
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function unavailable(reason: string): AgentResourceReadResult {
  return { status: 'unavailable', reason };
}
