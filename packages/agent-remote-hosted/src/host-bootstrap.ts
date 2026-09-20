import type { GatewayAuthOptions } from './auth.js';
import { gatewayServiceProof } from './authority.js';
import { SharingError } from './host-sharing.js';

export interface HostKeyIdentity { subject: string; hostId: string; hostName: string }
export interface HostKeyCredentials { apiKey: string; keyId: string; baseUrl: string; model: string }
type HostKeyResult = { status: 'active'; credentials: HostKeyCredentials } | { status: 'denied' | 'unavailable' };

async function boundedBody(body: ReadableStream<Uint8Array> | null): Promise<string> {
  const reader = body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0; let expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => undefined); }, 5000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (expired) throw new SharingError(408, 'request_timeout', 'Request timed out.');
      if (done) break;
      size += value.byteLength;
      if (size > 16384) {
        void reader.cancel().catch(() => undefined);
        throw new SharingError(413, 'request_too_large', 'Request is too large.');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

export async function validateBootstrapBody(request: Request): Promise<void> {
  const raw = await boundedBody(request.body); if (!raw.trim()) return;
  let body: unknown;
  try { body = JSON.parse(raw); } catch { /* Return a constant error without reflecting input. */ }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
    throw new SharingError(400, 'invalid_request', 'No bootstrap parameters are accepted.');
  }
}

async function gatewayHostKeyRequest(auth: GatewayAuthOptions, operation: 'host-key' | 'revoke-host-key', identity: HostKeyIdentity): Promise<{ status: 'active'; value: unknown } | { status: 'denied' | 'unavailable' }> {
  const body = JSON.stringify(identity);
  try {
    const response = await fetch(auth.issuer + '/api/agent-remote/' + operation, { method: 'POST', body,
      redirect: 'manual', signal: AbortSignal.timeout(5000), headers: {
        authorization: 'Bearer ' + gatewayServiceProof(auth, operation, body), 'content-type': 'application/json',
      } });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return { status: [401, 403, 409, 410].includes(response.status) ? 'denied' : 'unavailable' };
    }
    const value: unknown = JSON.parse(await boundedBody(response.body));
    return { status: 'active', value };
  } catch { return { status: 'unavailable' }; }
}

export async function provisionGatewayHostKey(auth: GatewayAuthOptions, identity: HostKeyIdentity): Promise<HostKeyResult> {
  const result = await gatewayHostKeyRequest(auth, 'host-key', identity);
  if (result.status !== 'active') return result;
  const value = result.value;
  if (!value || typeof value !== 'object') return { status: 'unavailable' };
  const data = value as Record<string, unknown>;
  const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\u0000-\u001f\u007f]/.test(value);
  if (!text(data.apiKey, 4096) || !text(data.keyId, 256) || !text(data.model, 256) || data.baseUrl !== auth.issuer + '/v1') return { status: 'unavailable' };
  return { status: 'active', credentials: { apiKey: data.apiKey, keyId: data.keyId, baseUrl: data.baseUrl, model: data.model } };
}

export async function revokeGatewayHostKey(auth: GatewayAuthOptions, identity: HostKeyIdentity): Promise<boolean> {
  const result = await gatewayHostKeyRequest(auth, 'revoke-host-key', identity);
  return result.status === 'active' && !!result.value && typeof result.value === 'object' && 'ok' in result.value && result.value.ok === true;
}
