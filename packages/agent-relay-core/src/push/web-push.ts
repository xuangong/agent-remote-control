/**
 * The cryptography of Web Push, with Web Crypto only so it runs on Workers as in Node: the application server's VAPID authorization
 * (RFC 8292) and the payload's encryption for one subscription (RFC 8291 over the `aes128gcm` content coding of RFC 8188).
 * - A VAPID key is a P-256 pair: the public key is the uncompressed point (65 bytes) and the private key its scalar (32 bytes), both
 *   base64url, the form browsers take as `applicationServerKey` and Worker secrets hold as text.
 * - A token names the push service's origin (`aud`), expires within 24 hours (`exp`) and says who sends (`sub`, a `mailto:` or
 *   `https:` URL). It is signed with ES256, whose Web Crypto signature is already the JWS form (r and s, 32 bytes each).
 * - A payload is one record of at most 4096 bytes: an ephemeral sender key and a random salt per push, the plaintext and the
 *   last-record delimiter 2, no padding.
 */
export interface VapidKeys { readonly publicKey: string; readonly privateKey: string }
/** A subscription as the browser hands it out (`PushSubscription.toJSON()`): where to push, and the keys to encrypt for. */
export interface PushTarget { readonly endpoint: string; readonly keys: { readonly p256dh: string; readonly auth: string } }

/** The record size the sender writes, which is also the largest body a push service must accept. */
export const PUSH_RECORD_SIZE = 4096;
/** The largest plaintext that fits one record: the record less the header (86 bytes), the delimiter and the tag. */
export const PUSH_PLAINTEXT_LIMIT = PUSH_RECORD_SIZE - 86 - 1 - 16;
/** How long a token is valid; RFC 8292 allows at most 24 hours. */
export const VAPID_TOKEN_SECONDS = 12 * 60 * 60;

const subtle = () => globalThis.crypto.subtle;
const encoder = new TextEncoder();
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

export function toBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('The value is not base64url.');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};

/** Whether a value is a P-256 public key in the uncompressed form (65 bytes, starting with 4). */
export function isUncompressedKey(value: string): boolean {
  try { const bytes = fromBase64url(value); return bytes.length === 65 && bytes[0] === 4; } catch { return false; }
}

/** A new VAPID key pair, for a deployment's secret or a local Relay. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = await subtle().exportKey('jwk', pair.privateKey);
  return { publicKey: toBase64url(new Uint8Array(await subtle().exportKey('raw', pair.publicKey))), privateKey: jwk.d! };
}

/**
 * The signing key of a VAPID pair. Web Crypto does not check that a private scalar belongs to the public point it is given, so a
 * signature made with it must verify with the public key: a pair whose halves came from different keys is refused here, once,
 * instead of every push service refusing every push.
 */
export async function importVapidKeys(keys: VapidKeys): Promise<CryptoKey> {
  if (!isUncompressedKey(keys.publicKey)) throw new Error('The VAPID public key is not an uncompressed P-256 point in base64url.');
  const scalar = fromBase64url(keys.privateKey);
  if (scalar.length !== 32) throw new Error('The VAPID private key is not a 32-byte P-256 scalar in base64url.');
  const point = fromBase64url(keys.publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: toBase64url(point.subarray(1, 33)), y: toBase64url(point.subarray(33, 65)), ext: false };
  const mismatch = () => new Error('The VAPID private key does not belong to the public key.');
  // Node checks the pair as it imports it; a runtime that does not is caught by the signature below.
  const signing = await subtle().importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']).catch(() => { throw mismatch(); });
  const verifying = await subtle().importKey('raw', buffer(point), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const probe = encoder.encode('vapid key pair');
  const signature = await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, signing, buffer(probe));
  if (!await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, verifying, signature, buffer(probe))) throw mismatch();
  return signing;
}

/** The VAPID authorization header of a push to `endpoint` at `nowMs`: `vapid t=<token>, k=<public key>`. */
export async function vapidAuthorization(signing: CryptoKey, keys: { publicKey: string; subject: string }, endpoint: string, nowMs: number): Promise<{ header: string; expiresAt: number }> {
  const exp = Math.floor(nowMs / 1000) + VAPID_TOKEN_SECONDS;
  const encode = (value: unknown) => toBase64url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({ aud: new URL(endpoint).origin, exp, sub: keys.subject })}`;
  const signature = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, signing, buffer(encoder.encode(unsigned))));
  return { header: `vapid t=${unsigned}.${toBase64url(signature)}, k=${keys.publicKey}`, expiresAt: exp * 1000 };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await subtle().importKey('raw', buffer(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buffer(salt), info: buffer(info) }, key, length * 8));
}

/** Fixed inputs that are random in a real push, so a test can reproduce a known encryption (RFC 8291 Appendix A). */
export interface EncryptionInputs { readonly salt: Uint8Array; readonly senderKeys: CryptoKeyPair }

/** The `aes128gcm` body of one push for `target`: the header (salt, record size, sender key) and one encrypted record. */
export async function encryptPush(plaintext: Uint8Array, target: PushTarget, fixed?: EncryptionInputs): Promise<Uint8Array> {
  if (plaintext.length > PUSH_PLAINTEXT_LIMIT) throw new RangeError(`A push payload holds at most ${PUSH_PLAINTEXT_LIMIT} bytes.`);
  const browserKey = fromBase64url(target.keys.p256dh), auth = fromBase64url(target.keys.auth);
  if (browserKey.length !== 65 || browserKey[0] !== 4) throw new Error('The subscription key is not an uncompressed P-256 point.');
  if (auth.length < 16) throw new Error('The subscription auth secret is shorter than 16 bytes.');
  const salt = fixed?.salt ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  const sender = fixed?.senderKeys ?? await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const senderKey = new Uint8Array(await subtle().exportKey('raw', sender.publicKey));
  const browser = await subtle().importKey('raw', buffer(browserKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: browser }, sender.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(encoder.encode('WebPush: info\0'), browserKey, senderKey), 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle().importKey('raw', buffer(cek), 'AES-GCM', false, ['encrypt']);
  const record = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buffer(nonce) }, key, buffer(concat(plaintext, new Uint8Array([2])))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, PUSH_RECORD_SIZE);
  header[20] = senderKey.length;
  return concat(header, senderKey, record);
}
