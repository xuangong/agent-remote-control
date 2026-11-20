import type { SessionEntry } from '../session-tree.js';
import { conversationLocalStorage } from '../conversation-storage.js';
import type { OpenedSession } from '../directory-client.js';
import { Menu } from '../ui/Menu.js';

export const nonTextInputTypes = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);

export /** Whether a control uses Escape itself: text fields, selects and editable content. */
function keepsEscape(target: Element): boolean {
  const field = target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  return !!field && !(field instanceof HTMLInputElement && nonTextInputTypes.has(field.type));
}

export /** Whether focus is in the Window sidebar, or in a Menu (portalled outside it) whose trigger is in it. */
function focusWithinContext(): boolean {
  const context = document.getElementById('lab-context'), active = document.activeElement;
  if (!context || !active) return false;
  if (context.contains(active)) return true;
  const menu = active.closest('[role="menu"]');
  return !!menu?.id && [...context.querySelectorAll('[aria-controls]')].some(control => control.getAttribute('aria-controls') === menu.id);
}

export function createAgentId(): string {
  return `lab-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
}

export function isCompactLayout(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1180px)').matches;
}

export function rememberedAgent(): string | undefined {
  const value = new URL(window.location.href).searchParams.get('agent');
  return value && value.length > 0 ? value : undefined;
}

export function rememberAgent(agentId: string): void {
  if (window.history.state?.agentRemoteVisit) return;
  const url = new URL(window.location.href);
  url.searchParams.set('agent', agentId);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

export function openedSessionsKey(baseUrl: string): string { return `agent-remote-opened:${baseUrl}`; }

export function readOpenedSessions(baseUrl: string): OpenedSession[] {
  try {
    const value: unknown = JSON.parse(conversationLocalStorage.getItem(openedSessionsKey(baseUrl)) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is OpenedSession => item !== null && typeof item === 'object' && ['agentId', 'providerId', 'nativeSessionId', 'title'].every((key) => typeof item[key] === 'string')).slice(0, 100).map(openedSessionMetadata);
  } catch { return []; }
}

export function openedSessionMetadata(item: OpenedSession): OpenedSession {
  return { agentId: item.agentId, providerId: item.providerId, nativeSessionId: item.nativeSessionId, title: item.title,
    ...(typeof item.hostId === 'string' ? { hostId: item.hostId } : {}),
    ...(typeof item.parentAgentId === 'string' ? { parentAgentId: item.parentAgentId } : {}),
    ...(typeof item.parentNativeSessionId === 'string' ? { parentNativeSessionId: item.parentNativeSessionId } : {}),
    ...(typeof item.createdAt === 'string' ? { createdAt: item.createdAt } : {}) };
}

export function viewKey(session: Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId'>): string {
  const id = (session as { viewId?: string }).viewId;
  if (!id) throw new Error('Session View identity is missing.');
  return id;
}
