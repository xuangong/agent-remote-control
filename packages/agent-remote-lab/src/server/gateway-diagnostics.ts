import { createHmac, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { GatewayAuthOptions } from '@orchardworks/agent-remote-hosted';
import { pruneRelayDiagnostics, type RelayDiagnosticStore } from '@orchardworks/agent-remote-hosted/relay-diagnostics';

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/** Diagnostic snapshots never participate in the authenticated business-state commit. */
export function openGatewayDiagnostics(stateFile: string, auth: GatewayAuthOptions): RelayDiagnosticStore {
  const file = stateFile + '.diagnostics.json';
  const scope = createHmac('sha256', auth.secret).update(JSON.stringify(['arc-diagnostics', 1, auth.origin, auth.issuer])).digest('hex');
  let initial: unknown = [];
  try {
    const input = openSync(file, 'r');
    try {
      const metadata = fstatSync(input);
      if (metadata.isFile() && metadata.size <= MAX_SNAPSHOT_BYTES) {
        const snapshot = JSON.parse(readFileSync(input, 'utf8'));
        if (snapshot?.version === 1 && snapshot.scope === scope) initial = pruneRelayDiagnostics(snapshot.entries);
      }
    } finally { closeSync(input); }
  } catch { /* Missing or corrupt diagnostics cannot prevent Relay startup. */ }
  return {
    initial,
    async save(entries) {
      const content = JSON.stringify({ version: 1, scope, entries: pruneRelayDiagnostics(entries) });
      if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES) throw new Error('Diagnostic snapshot exceeds its size limit.');
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        const output = await open(temporary, 'wx', 0o600);
        try { await output.writeFile(content); await output.sync(); } finally { await output.close(); }
        await rename(temporary, file);
        const directory = await open(dirname(file), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    },
  };
}
