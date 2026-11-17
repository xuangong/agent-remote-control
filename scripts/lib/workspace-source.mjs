import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagesRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages');

/** Workspace package name to its directory and exports map, read once from the packages' manifests. */
function workspacePackages() {
  const packages = new Map();
  for (const directory of readdirSync(packagesRoot)) {
    const manifestPath = join(packagesRoot, directory, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.exports) packages.set(manifest.name, { directory: join(packagesRoot, directory), exports: manifest.exports });
  }
  return packages;
}

/** The `import` target of an export entry, such as ./dist/index.js; plain strings such as ./dist/styles.css count too. */
function importTarget(entry) {
  return typeof entry === 'string' ? entry : entry?.import;
}

/** Finds the entry for a subpath, including a `./*` pattern, and the part of the path the pattern matched. */
function exportEntry(exports, subpath) {
  if (exports[subpath] !== undefined) return { target: importTarget(exports[subpath]) };
  const pattern = exports['./*'];
  if (pattern !== undefined && subpath.startsWith('./')) return { target: importTarget(pattern)?.replace('*', subpath.slice(2)) };
  return undefined;
}

/** The TypeScript source that a package's dist/<path>.js is built from, when it exists. */
function sourceFile(packageDirectory, path) {
  for (const extension of ['.ts', '.tsx']) {
    const candidate = join(packageDirectory, 'src', `${path}${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Vite plugin for tests: a workspace package imported by name resolves to its TypeScript source instead of its build
 * output, so a dependant's tests see the current source of every dependency without building it first. The published
 * `exports` maps keep pointing at dist; only the test resolver is redirected.
 */
export function workspaceSource() {
  const packages = workspacePackages();
  return {
    name: 'arc-workspace-source',
    enforce: 'pre',
    resolveId(source, importer) {
      // A relative import of another package's build output, such as ../../agent-provider-sdk/dist/index.js, must reach
      // the same module instance as the same package imported by name.
      if (source.startsWith('.') && importer) {
        const from = dirname(importer.replace(/[?#].*$/, ''));
        const built = /^(.*\/packages\/[^/]+)\/dist\/(.+)\.js$/.exec(resolve(from, source).replaceAll('\\', '/'));
        // A package's own build output stays as it is: its tests may start child processes from it.
        if (built && !from.replaceAll('\\', '/').startsWith(`${built[1]}/`)) return sourceFile(built[1], built[2]);
        return null;
      }
      const match = /^(@orchardworks\/[^/]+)(\/.+)?$/.exec(source);
      const workspace = match && packages.get(match[1]);
      if (!workspace) return null;
      const target = exportEntry(workspace.exports, match[2] ? `.${match[2]}` : '.')?.target;
      const built = target && /^\.\/dist\/(.+)\.js$/.exec(target);
      if (built) {
        const file = sourceFile(workspace.directory, built[1]);
        if (file) return file;
      }
      const asset = target && /^\.\/dist\/(.+\.css)$/.exec(target);
      if (asset && existsSync(join(workspace.directory, 'src', asset[1]))) return join(workspace.directory, 'src', asset[1]);
      return null;
    },
  };
}

/**
 * The same resolution as an esbuild plugin, for tests that bundle a Worker from workspace source: every workspace
 * package and package subpath imported by name resolves to its TypeScript source, as in Vitest.
 */
export function workspaceSourceEsbuild() {
  const resolver = workspaceSource();
  return {
    name: 'arc-workspace-source',
    setup(build) {
      build.onResolve({ filter: /^@orchardworks\// }, args => {
        const path = resolver.resolveId(args.path, args.importer);
        return path ? { path } : undefined;
      });
    },
  };
}
