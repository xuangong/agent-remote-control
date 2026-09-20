import { cancelRecoveryWrites, flushRecoveryWrites, queueRecoveryWrite } from './recovery-writes.js';
import { createContext } from 'react';
import { controllerPath, readControllerLocation, type ControllerLocation } from '@agent-remote-controller/agent-remote-hosted/controller-location';
import { clearImageDraftScope } from '@agent-remote-controller/agent-remote-web/react';
import type { TimelineReadingPosition } from '@agent-remote-controller/agent-remote-web/react';

const prefix = 'agent-remote:recovery:';
export const RecoveryScope = createContext<ReadingPositions | undefined>(undefined);

export function readLastSession(scope: string): ControllerLocation | undefined {
  try {
    const path = localStorage.getItem(`${prefix}${scope}:session`);
    if (!path?.startsWith('/?')) return;
    const location = readControllerLocation(new URLSearchParams(path.slice(2)));
    if (location.hostId && location.providerId && location.nativeSessionId) return location;
  } catch { /* Corrupt or unavailable storage must not prevent opening the app. */ }
}

export function saveLastSession(scope: string, location: ControllerLocation): void {
  try { localStorage.setItem(`${prefix}${scope}:session`, controllerPath(location)); }
  catch { /* The current conversation remains usable without storage. */ }
}

export function readDrafts(scope: string): Record<string, string> {
  flushRecoveryWrites(`${prefix}${scope}:drafts`);
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(`${prefix}${scope}:drafts`) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { return {}; }
}

export function saveDrafts(scope: string, drafts: Record<string, string>): void {
  queueRecoveryWrite(`${prefix}${scope}:drafts`, () => JSON.stringify(drafts));
}

export function clearConversationRecovery(scope?: string): void {
  cancelRecoveryWrites(scope ? `${prefix}${scope}:` : prefix);
  if (scope) void clearImageDraftScope(scope).catch(() => { /* Signout still completes when browser storage is unavailable. */ });
  try {
    for (const storage of [sessionStorage, localStorage]) {
      for (const key of Object.keys(storage)) if (key.startsWith(scope ? `${prefix}${scope}:` : prefix)) storage.removeItem(key);
    }
  } catch { /* Signing out must also work when storage is disabled. */ }
}

// The renderer owns anchors; the application only stores them for this tab and relay.
export class ReadingPositions extends Map<string, TimelineReadingPosition> {
  private readonly storageKey: string;
  constructor(readonly scope: string) {
    super();
    this.storageKey = `${prefix}${scope}:reading`;
    flushRecoveryWrites(this.storageKey);
    try {
      const entries: unknown = JSON.parse(sessionStorage.getItem(this.storageKey) ?? '[]');
      if (Array.isArray(entries)) for (const entry of entries.slice(-80)) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
        const value = entry[1];
        if (value && typeof value.following === 'boolean' && (!value.anchor ||
          (typeof value.anchor.key === 'string' && typeof value.anchor.offset === 'number' && Number.isFinite(value.anchor.offset)))) super.set(entry[0], value);
      }
    } catch { /* A fresh reading position is safe if recovery data is unavailable. */ }
  }
  override set(key: string, value: TimelineReadingPosition): this {
    const previous = this.get(key);
    if (previous?.following === value.following && JSON.stringify(previous?.anchor) === JSON.stringify(value.anchor)) return this;
    super.delete(key);
    super.set(key, value);
    if (this.size > 80) super.delete(this.keys().next().value!);
    queueRecoveryWrite(this.storageKey, () => JSON.stringify([...this]));
    return this;
  }
}
