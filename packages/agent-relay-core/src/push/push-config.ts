/**
 * The Relay's push configuration from its environment: the VAPID key pair (the public key a variable, the private key a secret) and the
 * subject it signs with. Both halves or neither: one alone is a configuration error, and the Relay runs without push.
 */
import { isUncompressedKey, type VapidKeys } from './web-push.js';

export interface PushEnvironment {
  /** The VAPID public key, an uncompressed P-256 point in base64url; browsers subscribe with it. A variable: it is public. */
  AGENT_REMOTE_PUSH_PUBLIC_KEY?: string;
  /** The VAPID private key, the 32-byte scalar in base64url. A secret (`wrangler secret put`), never a variable. */
  AGENT_REMOTE_PUSH_PRIVATE_KEY?: string;
  /** Who sends, as push services see it: a `mailto:` or `https:` URL. The Relay's own origin by default. */
  AGENT_REMOTE_PUSH_SUBJECT?: string;
}

/** What the Relay needs to send pushes. */
export interface PushConfiguration {
  readonly vapid: VapidKeys & { readonly subject: string };
  /** The push services the Relay sends to; the browsers' own by default. A test stack adds its simulator. */
  readonly endpoints?: (url: URL) => boolean;
  /** The push service port; `fetch` by default. */
  readonly post?: (request: Request) => Promise<Response>;
}

/** The subject a Relay signs with by default: its own HTTPS origin, or a mailto: address for a local one, which push services accept. */
export function defaultPushSubject(origin: string): string {
  return new URL(origin).protocol === 'https:' ? new URL(origin).origin : 'mailto:orchard@localhost';
}

/** The configuration, nothing when push is not configured, or why the configuration is refused. */
export function pushFromEnvironment(env: PushEnvironment, origin: string): { configuration?: PushConfiguration; problem?: string } {
  const publicKey = env.AGENT_REMOTE_PUSH_PUBLIC_KEY?.trim(), privateKey = env.AGENT_REMOTE_PUSH_PRIVATE_KEY?.trim();
  if (!publicKey && !privateKey) return {};
  if (!publicKey || !privateKey) {
    return { problem: `${publicKey ? 'AGENT_REMOTE_PUSH_PUBLIC_KEY is set but the secret AGENT_REMOTE_PUSH_PRIVATE_KEY is not' : 'AGENT_REMOTE_PUSH_PRIVATE_KEY is set but AGENT_REMOTE_PUSH_PUBLIC_KEY is not'}; push notifications are off. Set both (see the deployment guide).` };
  }
  if (!isUncompressedKey(publicKey)) return { problem: 'AGENT_REMOTE_PUSH_PUBLIC_KEY is not an uncompressed P-256 public key in base64url; push notifications are off.' };
  if (!/^[A-Za-z0-9_-]{43}$/.test(privateKey)) return { problem: 'AGENT_REMOTE_PUSH_PRIVATE_KEY is not a 32-byte P-256 private key in base64url; push notifications are off.' };
  const subject = env.AGENT_REMOTE_PUSH_SUBJECT?.trim() || defaultPushSubject(origin);
  if (!/^(mailto:.+|https:\/\/.+)$/.test(subject)) return { problem: 'AGENT_REMOTE_PUSH_SUBJECT must be a mailto: or https: URL; push notifications are off.' };
  return { configuration: { vapid: { publicKey, privateKey, subject } } };
}
