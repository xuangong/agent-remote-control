import { useState } from 'react';
import type { TimelineDisplayMode } from '@orchardworks/agent-remote-web/react';
import type { SessionDisplayPreferences } from '../components/SessionViewOptions.js';
import { conversationLocalStorage } from '../conversation-storage.js';

function readPreferences(storageKey: string | undefined, defaultMode?: TimelineDisplayMode): SessionDisplayPreferences {
  let preferences: SessionDisplayPreferences = { mode: defaultMode ?? 'preview', lettersVisible: true };
  try {
    const legacyMode = localStorage.getItem('agent-remote:timeline-display');
    if (!defaultMode && (legacyMode === 'simple' || legacyMode === 'content')) preferences.mode = legacyMode;
    preferences.lettersVisible = localStorage.getItem('agent-remote:show-letters') !== 'false';
    const saved: unknown = storageKey ? JSON.parse(conversationLocalStorage.getItem(storageKey) ?? 'null') : undefined;
    if (saved && typeof saved === 'object') {
      const value = saved as Partial<SessionDisplayPreferences>;
      if (value.mode === 'preview' || value.mode === 'simple' || value.mode === 'content') preferences.mode = value.mode;
      if (typeof value.lettersVisible === 'boolean') preferences.lettersVisible = value.lettersVisible;
    }
  } catch { /* A session remains usable without saved display preferences. */ }
  return preferences;
}

/** Product preferences follow native identity while the shared renderer stays local. */
export function useSessionDisplayPreferences(scope: string | undefined, sessionKey: string | undefined, defaultMode?: TimelineDisplayMode) {
  const identity = JSON.stringify([scope, sessionKey]);
  const storageKey = scope && sessionKey ? `agent-remote:recovery:${scope}:view:${sessionKey}` : undefined;
  const [selection, setSelection] = useState(() => ({ identity, preferences: readPreferences(storageKey, defaultMode) }));
  let current = selection;
  if (selection.identity !== identity) {
    current = { identity, preferences: readPreferences(storageKey, defaultMode) };
    setSelection(current);
  }
  function setPreferences(preferences: SessionDisplayPreferences): void {
    setSelection({ identity, preferences });
    if (storageKey) {
      try { conversationLocalStorage.setItem(storageKey, JSON.stringify(preferences)); }
      catch { /* Display choices also work when browser storage is unavailable. */ }
    }
  }
  return [current.preferences, setPreferences] as const;
}
