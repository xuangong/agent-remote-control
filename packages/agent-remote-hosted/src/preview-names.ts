import type { PreviewSnapshot } from '@orchardworks/agent-remote-tunnel';

export interface PreviewNames {
  pins?: Array<{ target: string; nameId: string }>;
  names?: Array<{ id: string; nameId: string }>;
}

export function validPreviewNames(value: Record<string, unknown>): boolean {
  const text = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value);
  if (value.pins !== undefined) {
    if (!Array.isArray(value.pins) || value.pins.length > 256) return false;
    const targets = new Set<string>(); const names = new Set<string>();
    for (const pin of value.pins) {
      if (!pin || typeof pin.target !== 'string' || !text(pin.nameId) || targets.has(pin.target) || names.has(pin.nameId)) return false;
      try { if (previewTargetKey(pin.target) !== pin.target) return false; } catch { return false; }
      targets.add(pin.target); names.add(pin.nameId);
    }
  }
  if (value.names !== undefined) {
    if (!Array.isArray(value.names) || value.names.length > 384) return false;
    const ids = new Set<string>();
    for (const name of value.names) {
      if (!name || !text(name.id) || !text(name.nameId) || ids.has(name.id)) return false;
      ids.add(name.id);
    }
  }
  return true;
}

export function previewTargetKey(target: string): string {
  const url = new URL(target);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Invalid local preview origin.');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.origin;
}

export function previewNameId(state: PreviewNames | undefined, id: string): string {
  return state?.names?.find(value => value.id === id)?.nameId ?? id;
}

/** Keep names on live registrations stable; only new registrations inherit a reservation. */
export function reconcilePreviewNames(state: PreviewNames, snapshot: PreviewSnapshot): void {
  const existing = new Map((state.names ?? []).map(value => [value.id, value.nameId]));
  const active = snapshot.registrations.filter(value => value.status === 'active' && value.expiresAt > Date.now());
  const claimed = new Set(active.filter(value => existing.has(value.id)).map(value => existing.get(value.id)!));
  state.names = snapshot.registrations.map(value => {
    let nameId = existing.get(value.id);
    if (!nameId) {
      const pin = state.pins?.find(pin => pin.target === previewTargetKey(value.target));
      nameId = value.status === 'active' && value.expiresAt > Date.now() && pin && !claimed.has(pin.nameId) ? pin.nameId : value.id;
      if (value.status === 'active' && value.expiresAt > Date.now()) claimed.add(nameId);
    }
    return { id: value.id, nameId };
  });
}

export class PreviewNameError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
