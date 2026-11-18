/**
 * Test support: a state directory held in memory, so a store's rules are checked without a disk (see `StateFiles` in `state-file.ts`).
 *
 * Contract. The files live in `files`; a test reads one back with `text(name)` or `json(name)`, and seeds one with `put`. A published file is
 * replaced whole. `failNext` makes the following `publish` reject with the given error and leaves the files as they were. Only one small
 * real-disk test per store (the process tier) covers fsync and the atomic rename.
 */
import type { StateFiles } from './state-file.js';

export interface MemoryStateFiles extends StateFiles {
  readonly files: Map<string, string>;
  /** The text of a file; throws when it is missing, since a test that reads it expects it. */
  text(name: string): string;
  json<T = any>(name: string): T;
  /** Replace a file as a person or an older Controller would have left it. */
  put(name: string, content: string | object): void;
  /** The next `publish` rejects with this error and changes nothing. */
  failNext(error: Error): void;
  readonly published: string[];
}

export function memoryStateFiles(initial: Record<string, string> = {}): MemoryStateFiles {
  const files = new Map(Object.entries(initial));
  const published: string[] = [];
  let failure: Error | undefined;
  return {
    files, published,
    open: async () => {},
    list: async () => [...files.keys()],
    read: async name => files.get(name),
    publish: async (name, content) => {
      if (failure) { const error = failure; failure = undefined; throw error; }
      files.set(name, content); published.push(name);
    },
    text(name) { const text = files.get(name); if (text === undefined) throw new Error(`No state file ${name}.`); return text; },
    json(name) { return JSON.parse(this.text(name)); },
    put(name, content) { files.set(name, typeof content === 'string' ? content : JSON.stringify(content)); },
    failNext(error) { failure = error; },
  };
}
