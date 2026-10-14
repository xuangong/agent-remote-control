import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// The Relay image never starts local providers. Keep their SDKs and all build tools,
// but omit workstation CLI binaries from this Docker-only copy of the lockfile.
const nativePackage = /^(?:@anthropic-ai\/claude-agent-sdk-(?:darwin|linux|win32)-|@github\/copilot-(?:darwin|linux|linuxmusl|win32)-)[a-z0-9-]+$/;

export function prepareRelayDockerLock(source) {
  if (!/^lockfileVersion: '9\.0'$/m.test(source)) {
    throw new Error('Relay Docker installation requires pnpm lockfile format 9.0.');
  }
  const definitions = new Set();
  const snapshots = new Set();
  const references = new Set();
  let section;
  const blocks = source.split(/(?=^\S|^  \S)/m);
  const result = blocks.map((block) => {
    const sectionName = /^([a-zA-Z]+):/.exec(block)?.[1];
    if (sectionName) section = sectionName;
    if (section !== 'packages' && section !== 'snapshots') return block;
    const key = /^  '([^']+)':/.exec(block)?.[1];
    if (!key) return block;
    const name = key.slice(0, key.lastIndexOf('@'));
    if (nativePackage.test(name)) {
      if (section === 'packages') definitions.add(key);
      else {
        if (!/^    optional: true$/m.test(block) || /^    (?:optionalD|d)ependencies:/m.test(block)) {
          throw new Error(`Cannot omit non-leaf optional snapshot: ${key}`);
        }
        snapshots.add(key);
      }
      return '';
    }
    if (section !== 'snapshots') return block;
    return block.replace(/^    optionalDependencies:\n((?:^      .*(?:\n|$))*)/gm, (original, dependencies) => {
      const retained = dependencies.split('\n').filter((line) => {
        const dependency = /^      '([^']+)': (\S+)$/.exec(line);
        if (!dependency || !nativePackage.test(dependency[1])) return true;
        references.add(`${dependency[1]}@${dependency[2]}`);
        return false;
      }).join('\n');
      return retained.trim() ? `    optionalDependencies:\n${retained}` : '';
    });
  }).join('');
  if (![...definitions].every((key) => snapshots.has(key) && references.has(key)) ||
      definitions.size !== snapshots.size || definitions.size !== references.size) {
    throw new Error('Native CLI lock entries must have matching optional references and snapshots.');
  }
  // Fail closed if a future lock layout introduces a direct or unrecognized reference.
  for (const match of result.matchAll(/'(@[^']+)':/g)) {
    const name = match[1].includes('@', 1) ? match[1].slice(0, match[1].lastIndexOf('@')) : match[1];
    if (nativePackage.test(name)) throw new Error(`Unexpected native CLI reference: ${match[1]}`);
  }
  return { content: result, omitted: definitions.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || input === output) throw new Error('Usage: prepare-relay-docker-lock.mjs INPUT OUTPUT');
  const result = prepareRelayDockerLock(await readFile(input, 'utf8'));
  await writeFile(output, result.content);
  console.log(`Relay Docker lock omits ${result.omitted} optional native CLI distributions; SDKs and build tools are retained.`);
}
