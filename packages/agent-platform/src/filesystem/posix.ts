import { open, rename } from 'node:fs/promises';
import type { PlatformFilesystem } from './types.js';

export const posixFilesystem: PlatformFilesystem = {
  async syncDirectory(path) {
    const directory = await open(path, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  },
  async rename(source, target) { await rename(source, target); },
};
