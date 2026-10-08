import type { OpenedSession } from './directory-client.js';
import { conversationSessionStorage } from './conversation-storage.js';
import { flushRecoveryWrites, queueRecoveryWrite } from './recovery-writes.js';
import { sessionKey } from './session-tree.js';

export interface SessionComposition {
  path: OpenedSession[];
  focus?: string;
  anchor?: string;
  addressKey: string;
}

const storageKey = (scope: string) => `agent-remote:recovery:${scope}:composition`;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function hasIdentity(value: unknown): value is Record<string, unknown> & { hostId?: string; providerId: string; nativeSessionId: string } {
  return object(value) && nonempty(value.providerId) && nonempty(value.nativeSessionId)
    && (value.hostId === undefined || nonempty(value.hostId));
}

function sessionMetadata(value: unknown): OpenedSession | undefined {
  if (!object(value) || !hasIdentity(value) || !nonempty(value.agentId) || typeof value.title !== 'string') return;
  for (const key of ['parentAgentId', 'parentNativeSessionId', 'createdAt']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return;
  }
  return { agentId: value.agentId, providerId: value.providerId, nativeSessionId: value.nativeSessionId, title: value.title,
    ...(value.hostId !== undefined ? { hostId: value.hostId } : {}),
    ...(typeof value.parentAgentId === 'string' ? { parentAgentId: value.parentAgentId } : {}),
    ...(typeof value.parentNativeSessionId === 'string' ? { parentNativeSessionId: value.parentNativeSessionId } : {}),
    ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}) };
}

function validatedComposition(value: unknown): SessionComposition | undefined {
  if (!object(value) || !Array.isArray(value.path) || value.path.length === 0 || value.path.length > 100) return;
  const path: OpenedSession[] = [];
  const keys = new Set<string>();
  for (const item of value.path) {
    const session = sessionMetadata(item);
    if (!session) return;
    const key = sessionKey(session);
    if (keys.has(key)) return;
    keys.add(key); path.push(session);
  }
  if (typeof value.addressKey !== 'string' || !keys.has(value.addressKey)) return;
  for (const key of ['focus', 'anchor']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !keys.has(value[key]))) return;
  }
  return { path, addressKey: value.addressKey,
    ...(typeof value.focus === 'string' ? { focus: value.focus } : {}),
    ...(typeof value.anchor === 'string' ? { anchor: value.anchor } : {}) };
}

/** A saved layout applies only to the exact native session in the current address. */
export function readSessionComposition(scope: string, requested: { hostId?: string; providerId?: string; nativeSessionId?: string } | undefined): SessionComposition | undefined {
  try {
    const key = storageKey(scope);
    flushRecoveryWrites(key);
    if (!hasIdentity(requested)) return;
    const value = validatedComposition(JSON.parse(conversationSessionStorage.getItem(key) ?? 'null'));
    return value?.addressKey === sessionKey(requested) ? value : undefined;
  } catch { return; }
}

export function saveSessionComposition(scope: string, value: SessionComposition): void {
  try {
    const saved = validatedComposition(value);
    if (saved) queueRecoveryWrite(storageKey(scope), () => JSON.stringify(saved));
  } catch { /* Ordinary session navigation remains available without layout persistence. */ }
}
