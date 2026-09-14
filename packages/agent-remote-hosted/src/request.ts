import { SharingError } from './host-sharing.js';
export async function readRequestBytes(request: Request, limit: number): Promise<Uint8Array> {
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => undefined); throw new SharingError(413, 'request_too_large', 'Request is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}
export async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  const body = await readRequestBytes(request, 16384);
  try { const value = JSON.parse(new TextDecoder().decode(body)); return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; }
  catch { return undefined; }
}
