import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const releaseVersion = '0.1.2-rc.1';
const releasePackage = '@deepseek-ai/dsh';

interface PackageMetadata {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

type MetadataReader = (name: string, version: string) => Promise<PackageMetadata>;

async function readPublishedMetadata(name: string, version: string): Promise<PackageMetadata> {
  const { stdout } = await execute('npm', [
    'view', `${name}@${version}`, 'name', 'version', 'dependencies', 'optionalDependencies', 'peerDependencies', '--json',
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout) as PackageMetadata;
}

export async function prepareDshRelease(directory: string, readMetadata: MetadataReader = readPublishedMetadata): Promise<string> {
  if (!isAbsolute(directory)) throw new Error('The DSH release directory must be an explicit absolute path.');
  const pending = [releasePackage];
  const discovered = new Set(pending);
  while (pending.length) {
    const batch = pending.splice(0, 8);
    const metadata = await Promise.all(batch.map((name) => readMetadata(name, releaseVersion)));
    for (const [index, item] of metadata.entries()) {
      if (item.name !== batch[index] || item.version !== releaseVersion) throw new Error(`Unexpected published DSH metadata for ${batch[index]}.`);
      const dependencies = { ...item.dependencies, ...item.optionalDependencies, ...item.peerDependencies };
      for (const name of Object.keys(dependencies)) {
        if (!name.startsWith('@deepseek-ai/dsh-') || discovered.has(name)) continue;
        discovered.add(name);
        pending.push(name);
      }
    }
  }
  const manifest = {
    name: 'agent-remote-lab-dsh-release',
    private: true,
    dependencies: { [releasePackage]: releaseVersion },
    overrides: Object.fromEntries([...discovered].sort().map((name) => [name, releaseVersion])),
  };
  await mkdir(directory, { recursive: true });
  const manifestPath = join(directory, 'package.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifestPath;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory) throw new Error('Usage: prepare:dsh-release <absolute-install-directory>');
  process.stdout.write(`${await prepareDshRelease(directory)}\n`);
}
