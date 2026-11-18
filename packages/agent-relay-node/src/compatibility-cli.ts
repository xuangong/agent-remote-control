import { loadCompatibilityManifest, requireProviderCompatibility } from './compatibility.js';

try {
  const manifest = loadCompatibilityManifest();
  const dsh = requireProviderCompatibility(manifest, 'dsh');
  if (dsh.native.revision === null) {
    throw new Error('DSH compatibility must declare an exact native revision.');
  }
  process.stdout.write(`${dsh.native.revision}\n${dsh.native.version}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Invalid Agent Remote compatibility manifest: ${message}\n`);
  process.exitCode = 2;
}
