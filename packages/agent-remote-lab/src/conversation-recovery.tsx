import { createContext } from 'react';
import type { TimelineReadingPosition } from '@agent-remote-controller/agent-remote-web/react';

const prefix = 'agent-remote:recovery:';
export const RecoveryScope = createContext<ReadingPositions | undefined>(undefined);

export function readDrafts(scope: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(`${prefix}${scope}:drafts`) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { return {}; }
}

export function saveDrafts(scope: string, drafts: Record<string, string>): void {
  try { sessionStorage.setItem(`${prefix}${scope}:drafts`, JSON.stringify(drafts)); }
  catch { /* Storage can be unavailable or full; in-memory editing remains usable. */ }
}

export function clearConversationRecovery(): void {
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix)) sessionStorage.removeItem(key);
  } catch { /* Signing out must also work when storage is disabled. */ }
}

// The renderer owns anchors; the application only stores them for this tab and relay.
export class ReadingPositions extends Map<string, TimelineReadingPosition> {
  private readonly storageKey: string;
  constructor(scope: string) {
    super();
    this.storageKey = `${prefix}${scope}:reading`;
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
    if (previous?.following === value.following && previous?.anchor?.key === value.anchor?.key && previous?.anchor?.offset === value.anchor?.offset) return this;
    super.delete(key);
    super.set(key, value);
    if (this.size > 80) super.delete(this.keys().next().value!);
    try { sessionStorage.setItem(this.storageKey, JSON.stringify([...this])); }
    catch { /* Reading still works without persistence. */ }
    return this;
  }
}
