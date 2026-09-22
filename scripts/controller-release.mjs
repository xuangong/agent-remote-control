import { fileURLToPath } from 'node:url';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PROTOCOL_VERSION } from '../packages/agent-remote-protocol/dist/index.js';
const root = new URL('../', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('packages/agent-host/package.json', root), 'utf8'));
const asset = `orchardworks-agent-remote-controller-${version}.tgz`;
const bytes = await readFile(new URL(`dist/agent-remote-controller/${asset}`, root));
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const info = JSON.parse(execFileSync('tar', ['-xOf', fileURLToPath(new URL(`dist/agent-remote-controller/${asset}`, root)), 'package/build-info.json'], { encoding: 'utf8' }));
if (info.version !== version || info.revision !== revision || info.dirty !== false) throw new Error('Build the release package from the clean release commit before creating its manifest.');
const manifest = { protocolVersion: PROTOCOL_VERSION, version, revision, asset, sha256: createHash('sha256').update(bytes).digest('hex'), nodeMajor: 22,
  platforms: ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'] };
await writeFile(new URL('dist/agent-remote-controller/controller-release.json', root), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Created controller-v${version} manifest for ${revision}`);

await copyFile(new URL('install.sh', root), new URL('dist/agent-remote-controller/install.sh', root));
await copyFile(new URL('install.ps1', root), new URL('dist/agent-remote-controller/install.ps1', root));
