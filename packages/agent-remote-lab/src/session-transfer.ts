import { readControllerLocation } from '@agent-remote-controller/agent-remote-hosted/controller-location';

export interface ScannedSession {
  hostId: string;
  providerId: string;
  nativeSessionId: string;
  parentNativeSessionId?: string;
}

/** Scanning selects an identity on this Controller, never an arbitrary navigation target. */
export function readSessionCode(text: string, origin: string): ScannedSession {
  let url: URL;
  try { url = new URL(text.trim()); } catch { throw new Error('This is not a session QR code. Scan a code from Agent Remote.'); }
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('This session link belongs to another site. Use a code from this Agent Remote site.');
  }
  if (url.pathname !== '/' || url.hash) throw new Error('This is not a session link.');
  const value = readControllerLocation(url.searchParams);
  if (!value.hostId || !value.providerId || !value.nativeSessionId || value.previewId) throw new Error('This code does not identify a session.');
  return { hostId: value.hostId, providerId: value.providerId, nativeSessionId: value.nativeSessionId,
    ...(value.parentNativeSessionId ? { parentNativeSessionId: value.parentNativeSessionId } : {}) };
}
