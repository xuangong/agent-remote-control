import { isBotView, type WindowGroup, type WindowSessionBinding } from '@orchardworks/agent-remote-protocol';
import { readControllerLocation, type SessionUse } from '@orchardworks/agent-remote-protocol/model';
import type { NativeSessionOwner } from '@orchardworks/agent-remote-protocol';
import { DirectoryError } from '../../kernel/directory-client.js';
import { windowBindingKey } from '../../kernel/window-composition.js';

/**
 * What a session link asks the page to do with its session (`agent-remote-controller session link --bot`), and what the
 * page does once the person confirms. A link names the session and the use, never a credential or a title; the page
 * asks first because a link in a chat or on a screen is not the person's own choice.
 *
 * Contract.
 * - `readSessionUseLink` finds the request in an address; an address without one, or an invalid one, has none.
 * - `addressWithoutSession` is that address with the session and its use removed, other parameters kept.
 * - `applySessionUse` attaches the session first. A session a native CLI still holds comes back as `held` with its owner,
 *   and nothing changes; the same call with that owner's generation takes it over. Only then is the bot made, or, when the
 *   session is already a bot, shown.
 */
export interface SessionUseRequest {
  readonly session: { readonly hostId: string; readonly providerId: string; readonly nativeSessionId: string };
  readonly use: SessionUse;
}

export function readSessionUseLink(search: string): SessionUseRequest | undefined {
  try {
    const location = readControllerLocation(new URLSearchParams(search));
    if (!location.sessionUse || !location.hostId || !location.providerId || !location.nativeSessionId) return undefined;
    return { session: { hostId: location.hostId, providerId: location.providerId, nativeSessionId: location.nativeSessionId }, use: location.sessionUse };
  } catch { return undefined; }
}

const LINK_KEYS = ['host', 'provider', 'session', 'parent', 'intent', 'keepOriginal', 'as', 'name'] as const;
export function addressWithoutSession(href: string): string {
  const url = new URL(href);
  for (const key of LINK_KEYS) url.searchParams.delete(key);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The bot view that already holds this session, in any group. */
export function existingBot(groups: readonly WindowGroup[], binding: WindowSessionBinding): { groupId: string; viewId: string } | undefined {
  const key = windowBindingKey(binding);
  for (const group of groups) {
    const view = group.window.views.find(candidate => isBotView(candidate) && windowBindingKey(candidate.binding) === key);
    if (group.bots && view) return { groupId: group.window.id, viewId: view.id };
  }
  return undefined;
}

export interface SessionUsePorts {
  /** Attaches the session on its Host; a native CLI that holds it fails with its owner, unless `takeOver` is that owner's generation. */
  attach(takeOver?: string): Promise<void>;
  /** The bot of this session when one exists. */
  existingBot(binding: WindowSessionBinding): { groupId: string; viewId: string } | undefined;
  /** Starts the bot's group from the binding and returns where it is. */
  createBot(binding: WindowSessionBinding): Promise<{ groupId: string; viewId: string }>;
  /** Shows the bot. */
  show(place: { groupId: string; viewId: string }): void;
}
export type SessionUseOutcome =
  | { kind: 'created' | 'existing' }
  | { kind: 'held'; owner: NativeSessionOwner; message: string };

/** A bot is named after what the person typed, else the session's own title, else its identity. */
export function botBinding(request: SessionUseRequest, name: string, title: string | undefined): WindowSessionBinding {
  return { hostId: request.session.hostId, providerId: request.session.providerId, nativeSessionId: request.session.nativeSessionId,
    title: name.trim() || title || request.session.nativeSessionId };
}

export async function applySessionUse(request: SessionUseRequest, binding: WindowSessionBinding, ports: SessionUsePorts, takeOver?: string): Promise<SessionUseOutcome> {
  try { await ports.attach(takeOver); }
  catch (error) {
    if (error instanceof DirectoryError && error.nativeOwner) return { kind: 'held', owner: error.nativeOwner, message: error.message };
    throw error;
  }
  const known = ports.existingBot(binding);
  if (known) { ports.show(known); return { kind: 'existing' }; }
  ports.show(await ports.createBot(binding));
  return { kind: 'created' };
}
