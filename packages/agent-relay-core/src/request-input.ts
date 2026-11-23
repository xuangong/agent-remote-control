import { isCreationSource, type CreationSource } from '@orchardworks/agent-remote-protocol';
import { BROKER_MAX_BODY_BYTES, type BrokerRequestContext } from './transport.js';
import { BrokerError, type Binding, type Host } from './broker-types.js';

export function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new BrokerError(400, 'invalid_request', `${name} must be a nonempty string.`);
  return value;
}
export function requiredHostIdentity(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new BrokerError(502, 'invalid_host_response', `The Remote Host returned an invalid ${name}.`);
  return value;
}
export function creationFingerprintSettings(body: Record<string, unknown>, names: readonly string[]): Record<string, string | boolean | CreationSource> {
  const settings = optionalSettings(body, names);
  // Validated legacy source/edit fields already uniquely determine provenance.
  // Keep their persisted identity unchanged, including redundant explicit input.
  if (body.sourceNativeSessionId !== undefined || body.editNativeSessionId !== undefined) delete settings.creationSource;
  return settings;
}
export function optionalSettings(body: Record<string, unknown>, names: readonly string[]): Record<string, string | boolean | CreationSource> {
  const result: Record<string, string | boolean | CreationSource> = {};
  for (const name of names) {
    const value = body[name];
    if (value === undefined) continue;
    if (name === 'planning') {
      if (typeof value !== 'boolean') throw new BrokerError(400, 'invalid_request', 'planning must be a boolean.');
      result[name] = value;
    } else if (name === 'creationSource') {
      if (!isCreationSource(value)) throw new BrokerError(400, 'invalid_request', 'A strict creation source is required.');
      result[name] = { providerId: value.providerId, nativeSessionId: value.nativeSessionId };
    } else result[name] = required(value, name);
  }
  return result;
}
export function sameBinding(binding: Binding, hostId: string, providerId: string, nativeSessionId: string): boolean {
  return binding.hostId === hostId && binding.providerId === providerId && binding.nativeSessionId === nativeSessionId;
}
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const parts: Uint8Array[] = []; let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > BROKER_MAX_BODY_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw new BrokerError(413, 'request_too_large', 'The request body is too large.');
        }
        parts.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(parts).toString() || '{}'); } catch { throw new BrokerError(400, 'invalid_json', 'The request body must be JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrokerError(400, 'invalid_request', 'The request body must be an object.');
  return value as Record<string, unknown>;
}
/** Providers a Host names in its handshake (read-only, coordinator): at most 64 valid identities, the rest ignored. */
export function namedProviders(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim() && value.length <= 512))].slice(0, 64);
}

/** The subject a request acts for, as the host environment authenticated it. */
export const principal = (context: BrokerRequestContext) => context.principalSubject?.();

/** One group of routes: answers a Response for a path it owns and undefined for any other, after the Relay's common checks. */
export type RouteGroup = (request: Request, context: BrokerRequestContext, url: URL, subject: string | undefined) => Promise<Response | undefined>;
