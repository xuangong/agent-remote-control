import { readControllerLocation } from '@orchardworks/agent-remote-protocol/model';
import { withMessageKey } from '@orchardworks/agent-client';

export interface ScannedSession {
  hostId: string;
  providerId: string;
  nativeSessionId: string;
  parentNativeSessionId?: string;
  sessionIntent?: 'history';
  keepOriginal?: boolean;
}

/** Scanning selects an identity on this Controller, never an arbitrary navigation target. */
export function readSessionCode(text: string, origin: string): ScannedSession {
  let url: URL;
  try { url = new URL(text.trim()); } catch { throw withMessageKey(new Error('This is not a session QR code. Scan a code from Orchard.'), 'client.transfer.notQr'); }
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw withMessageKey(new Error('This session link belongs to another site. Use a code from this Orchard site.'), 'client.transfer.otherSite');
  }
  if (url.pathname !== '/' || url.hash) throw withMessageKey(new Error('This is not a session link.'), 'client.transfer.notLink');
  const value = readControllerLocation(url.searchParams);
  if (!value.hostId || !value.providerId || !value.nativeSessionId || value.previewId) throw withMessageKey(new Error('This code does not identify a session.'), 'client.transfer.noSession');
  return { hostId: value.hostId, providerId: value.providerId, nativeSessionId: value.nativeSessionId,
    ...(value.sessionIntent ? { sessionIntent: value.sessionIntent } : {}),
    ...(value.keepOriginal ? { keepOriginal: true } : {}),
    ...(value.parentNativeSessionId ? { parentNativeSessionId: value.parentNativeSessionId } : {}) };
}
