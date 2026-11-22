import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import type { Plugin } from 'vite';
import type { AppShell } from './src/app-shell/app-shell.js';

/** A file of the build as the shell reads it: a chunk with what it loads before it runs, or an asset. */
export interface BuiltFile {
  readonly fileName: string;
  readonly type: 'chunk' | 'asset';
  readonly name?: string;
  readonly isEntry?: boolean;
  /** Chunks a chunk imports statically. */
  readonly imports?: readonly string[];
  /** CSS and other assets a chunk loads with it. */
  readonly loads?: readonly string[];
  /** The bytes, for the version. */
  readonly content: string | Uint8Array;
}

/**
 * The shell of a build: the entry chunk and the chunks named in `startChunks` (the workbench's `App`, which the entry loads at once),
 * with everything they load before they run. The version is a digest of every file of the build, so any change installs a new worker.
 */
export function shellOf(files: readonly BuiltFile[], startChunks: readonly string[]): AppShell {
  const byName = new Map(files.map(file => [file.fileName, file]));
  const shell = new Set<string>();
  const visit = (fileName: string) => {
    if (shell.has(fileName)) return;
    const file = byName.get(fileName);
    if (!file) throw new Error(`The app shell names ${fileName}, which the build does not have.`);
    shell.add(fileName);
    for (const next of [...file.imports ?? [], ...file.loads ?? []]) visit(next);
  };
  const starts = files.filter(file => file.type === 'chunk' && (file.isEntry || startChunks.includes(file.name ?? '')));
  for (const name of startChunks) if (!starts.some(file => file.name === name)) throw new Error(`No chunk ${name} to start the app shell with.`);
  for (const file of starts) visit(file.fileName);
  const digest = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.fileName.localeCompare(b.fileName))) digest.update(file.fileName).update('\0').update(file.content).update('\0');
  return { version: digest.digest('hex').slice(0, 16), files: [...shell].sort().map(fileName => `/${fileName}`) };
}

/**
 * Builds the app's service worker into `sw.js` at the site's root, with this build's shell (see src/app-shell/app-shell.ts). The worker
 * is bundled on its own as a classic script, which every browser that has service workers runs.
 */
export function appShellWorker(options: { worker: string; startChunks: readonly string[] }): Plugin {
  return {
    name: 'orchard-app-shell',
    apply: 'build',
    enforce: 'post',
    async generateBundle(_options, bundle) {
      const files: BuiltFile[] = Object.values(bundle).map(item => item.type === 'chunk'
        ? { fileName: item.fileName, type: 'chunk', name: item.name, isEntry: item.isEntry, imports: item.imports,
          loads: [...item.viteMetadata?.importedCss ?? [], ...item.viteMetadata?.importedAssets ?? []], content: item.code }
        : { fileName: item.fileName, type: 'asset', content: item.source });
      const shell = shellOf(files, options.startChunks);
      const worker = await build({ entryPoints: [options.worker], bundle: true, write: false, format: 'iife', target: 'es2020', minify: true,
        define: { __APP_SHELL__: JSON.stringify(shell) }, logLevel: 'silent' });
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: worker.outputFiles[0]!.text });
    },
  };
}
