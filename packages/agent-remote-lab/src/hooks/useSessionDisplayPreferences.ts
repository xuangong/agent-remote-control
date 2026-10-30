import { useWindowLayout } from '../window-workspace-context.js';
import { useState } from 'react';
import type { TimelineDisplayMode } from '@orchardworks/agent-remote-web/react';
import type { SessionDisplayPreferences } from '../components/SessionViewOptions.js';
import { clearCacheOnClose, conversationLocalStorage } from '../conversation-storage.js';
import { recoveryGeneration } from '../conversation-recovery.js';

export interface DisplayPreferenceBinding { scope: string; key: string }
export interface DisplayPreferenceSnapshot {
  status: 'ready' | 'failed' | 'cancelled'; revision: number; preferences: SessionDisplayPreferences;
  retention: 'page' | 'local';
}
interface DisplayEntry extends DisplayPreferenceSnapshot { generation: number; initialized: boolean; dirty: boolean; explicit: boolean; defaultSelected: boolean }
const retained = new Map<string, DisplayEntry>();
const identity = (binding: DisplayPreferenceBinding) => JSON.stringify([binding.scope, binding.key]);
const storageKey = (binding: DisplayPreferenceBinding) => `agent-remote:recovery:${binding.scope}:view:${binding.key}`;
const valid = (value: unknown): value is SessionDisplayPreferences => !!value && typeof value === 'object' && 'mode' in value
  && ['preview', 'simple', 'content'].includes(String(value.mode)) && 'lettersVisible' in value && typeof value.lettersVisible === 'boolean';
function defaults(defaultMode?: TimelineDisplayMode): SessionDisplayPreferences {
  const preferences: SessionDisplayPreferences = { mode: defaultMode ?? 'simple', lettersVisible: true };
  try {
    const legacyMode = localStorage.getItem('agent-remote:timeline-display');
    if (!defaultMode && (legacyMode === 'simple' || legacyMode === 'content')) preferences.mode = legacyMode;
    preferences.lettersVisible = localStorage.getItem('agent-remote:show-letters') !== 'false';
  } catch { /* Legacy defaults do not certify scoped retention. */ }
  return preferences;
}
function entryFor(binding: DisplayPreferenceBinding, defaultMode?: TimelineDisplayMode, mounted = false): DisplayEntry {
  const key = identity(binding), generation = recoveryGeneration(binding.scope);
  let entry = retained.get(key);
  if (entry?.generation === generation) {
    if (mounted && !entry.defaultSelected) {
      if (!entry.explicit) {
        const preferences = defaults(defaultMode);
        if (preferences.mode !== entry.preferences.mode || preferences.lettersVisible !== entry.preferences.lettersVisible) entry.revision++;
        entry.preferences = preferences;
      }
      entry.defaultSelected = true;
    }
    return entry;
  }
  entry = { status: 'ready', revision: 0, preferences: defaults(defaultMode), retention: clearCacheOnClose() ? 'page' : 'local',
    generation, initialized: false, dirty: false, explicit: false, defaultSelected: mounted };
  try {
    const raw = conversationLocalStorage.getItem(storageKey(binding));
    if (raw !== null) { const value: unknown = JSON.parse(raw); if (!valid(value)) throw new Error('Invalid display preferences.'); entry.preferences = { mode: value.mode, lettersVisible: value.lettersVisible }; entry.explicit = true; }
    entry.initialized = true;
  } catch { entry.status = 'failed'; entry.retention = 'page'; }
  retained.set(key, entry); return entry;
}
function snapshot(entry: DisplayEntry): DisplayPreferenceSnapshot { return { status: entry.status, revision: entry.revision, preferences: { ...entry.preferences }, retention: entry.retention }; }
export function inspectSessionDisplayPreferences(binding: DisplayPreferenceBinding): DisplayPreferenceSnapshot { return snapshot(entryFor(binding)); }
export function flushSessionDisplayPreferences(binding: DisplayPreferenceBinding, revision: number, isCurrent: () => boolean): DisplayPreferenceSnapshot {
  const entry = entryFor(binding), current = () => isCurrent() && entry.generation === recoveryGeneration(binding.scope) && entry.revision === revision && retained.get(identity(binding)) === entry;
  if (!current()) return { ...snapshot(entry), status: 'cancelled', retention: 'page' };
  if (!entry.initialized) {
    try {
      const raw = conversationLocalStorage.getItem(storageKey(binding));
      const value: unknown = raw === null ? undefined : JSON.parse(raw);
      if (value !== undefined && !valid(value)) throw new Error('Invalid display preferences.');
      if (!entry.dirty && value) { entry.preferences = value as SessionDisplayPreferences; entry.explicit = true; }
      entry.initialized = true;
    } catch { return { ...snapshot(entry), status: 'failed', retention: 'page' }; }
  }
  try {
    if (!current()) return { ...snapshot(entry), status: 'cancelled', retention: 'page' };
    if (entry.dirty) conversationLocalStorage.setItem(storageKey(binding), JSON.stringify(entry.preferences));
    else {
      const raw = conversationLocalStorage.getItem(storageKey(binding));
      if (raw !== null) {
        const value: unknown = JSON.parse(raw);
        if (!valid(value) || value.mode !== entry.preferences.mode || value.lettersVisible !== entry.preferences.lettersVisible) throw new Error('Display preferences changed.');
      } else if (entry.explicit) conversationLocalStorage.setItem(storageKey(binding), JSON.stringify(entry.preferences));
    }
    if (!current()) return { ...snapshot(entry), status: 'cancelled', retention: 'page' };
    entry.status = 'ready'; entry.dirty = false; entry.retention = clearCacheOnClose() ? 'page' : 'local';
  } catch { entry.status = 'failed'; entry.retention = 'page'; }
  return snapshot(entry);
}

/** Concrete display ownership is independent of native attachment and text/image owners. */
export function useSessionDisplayPreferences(scope: string | undefined, sessionKey: string | undefined, defaultMode?: TimelineDisplayMode) {
  const shared = useWindowLayout();
  const viewId = sessionKey && (shared?.resolveViewId?.(sessionKey) ?? sessionKey);
  const view = shared?.window.views.find(item => item.id === viewId);
  const binding = scope && sessionKey ? { scope, key: sessionKey } : undefined;
  const key = JSON.stringify([scope, sessionKey]);
  const read = () => binding ? entryFor(binding, defaultMode, true).preferences : defaults(defaultMode);
  const [selection, setSelection] = useState(() => ({ identity: key, preferences: read() }));
  let current = selection;
  if (selection.identity !== key) { current = { identity: key, preferences: read() }; setSelection(current); }
  function setPreferences(preferences: SessionDisplayPreferences): void {
    if (shared) { if (view) shared.operate({ type: 'view.display', viewId: view.id, display: preferences }); return; }
    setSelection({ identity: key, preferences });
    if (binding) {
      const entry = entryFor(binding, defaultMode, true);
      entry.preferences = { ...preferences }; entry.revision++; entry.dirty = true; entry.explicit = true;
      flushSessionDisplayPreferences(binding, entry.revision, () => true);
    }
  }
  return [view?.display ?? current.preferences, setPreferences] as const;
}
