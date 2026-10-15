import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const hostEntry = fileURLToPath(import.meta.resolve('@orchardworks/agent-remote-controller/local-session-succession'));
const hostDist = dirname(hostEntry);
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const allowedInputs = new Set(['local-session-succession', 'local-session-runtime', 'session-succession-service', 'session-succession', 'session-succession-store',
  'session-succession-context', 'local-succession-preparation', 'session-succession-boundary', 'session-source-binding', 'source-participant', 'succession-persistence', 'session-reference'].map(name => `${name}.js`));
const publicPackages = new Set(['@orchardworks/agent-provider-sdk', '@orchardworks/agent-remote-protocol', '@orchardworks/agent-remote-relay']);
const isExternal = name => name.startsWith('node:') || builtinModules.includes(name) || publicPackages.has(name) && Object.hasOwn(manifest.dependencies, name);
const result = await build({ absWorkingDir: root, entryPoints: ['src/local-session-succession.ts'], outfile: 'dist/local-session-succession.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true, external: [...publicPackages], sourcemap: false });
for (const [input, info] of Object.entries(result.metafile.inputs)) {
  const absolute = resolve(root, input);
  if (absolute !== join(root, 'src/local-session-succession.ts') && (dirname(absolute) !== hostDist || !allowedInputs.has(basename(absolute)))) throw new Error(`Forbidden local succession bundle input: ${input}`);
  for (const imported of info.imports) if (imported.external && !isExternal(imported.path)) throw new Error(`Undeclared local succession external: ${imported.path}`);
}
for (const output of Object.values(result.metafile.outputs)) for (const imported of output.imports) if (!imported.external || !isExternal(imported.path)) throw new Error(`Invalid emitted local succession import: ${imported.path}`);
const copied = new Set();
async function copyDeclaration(name) {
  if (copied.has(name)) return;
  if (basename(name) !== name || !name.endsWith('.d.ts')) throw new Error(`Declaration escaped the local closure: ${name}`);
  copied.add(name);
  const content = (await readFile(join(hostDist, name), 'utf8')).replace(/^\/\/# sourceMappingURL=.*$/gm, '');
  for (const match of content.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
    const target = match[1];
    if (target.startsWith('./')) await copyDeclaration(target.slice(2).replace(/\.js$/, '.d.ts'));
    else if (!isExternal(target)) throw new Error(`Private declaration dependency: ${target}`);
  }
  await writeFile(join(root, 'dist/internal/local-succession', name), content);
}
await mkdir(join(root, 'dist/internal/local-succession'), { recursive: true });
await copyDeclaration('local-session-succession.d.ts');
await writeFile(join(root, 'dist/local-session-succession.d.ts'), "export { LocalSessionSuccession, publishSuccessionState, type LocalSuccessionProvider } from './internal/local-succession/local-session-succession.js';\n");
await writeFile(join(root, 'dist/local-session-succession.meta.json'), JSON.stringify({ inputs: Object.keys(result.metafile.inputs).map(input => basename(input)),
  imports: Object.values(result.metafile.outputs).flatMap(output => output.imports.map(item => item.path)), declarations: [...copied].sort() }, null, 2) + '\n');
console.log(`Bundled local succession: ${Object.keys(result.metafile.inputs).length} modules, ${copied.size} local declarations.`);
