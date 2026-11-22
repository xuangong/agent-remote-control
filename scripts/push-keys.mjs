// Makes a VAPID key pair for Web Push (RFC 8292) with Web Crypto, as the Relay reads it: the public key is the uncompressed P-256 point
// and the private key its 32-byte scalar, both base64url. It writes the pair to a new file readable only by its owner and prints the
// public key alone, so the private key never reaches a terminal or a log:
//   node scripts/push-keys.mjs --out <file>
// The public key goes into the Relay's AGENT_REMOTE_PUSH_PUBLIC_KEY and the private key into its secret AGENT_REMOTE_PUSH_PRIVATE_KEY
// (docs/current/agent-remote/deployment.md, "Push notifications").
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const index = process.argv.indexOf('--out');
const out = index > 0 ? process.argv[index + 1] : undefined;
if (!out) {
  console.error('Usage: node scripts/push-keys.mjs --out <file>   (the file must not exist yet)');
  process.exit(2);
}
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;
const path = resolve(out);
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
const file = await open(path, 'wx', 0o600);
try { await file.writeFile(JSON.stringify({ version: 1, kind: 'vapid', publicKey, privateKey, createdAt: new Date().toISOString() }, null, 2) + '\n'); }
finally { await file.close(); }
console.log(`Wrote the VAPID key pair to ${path} (mode 0600).`);
console.log(`Public key (AGENT_REMOTE_PUSH_PUBLIC_KEY): ${publicKey}`);
