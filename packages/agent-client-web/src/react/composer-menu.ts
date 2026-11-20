/**
 * What the composer's "+" menu offers, and which of its items can be used now. One rule for the menu and every test of it: the
 * conditions are those the fitted toolbar carried before I4, moved here unchanged. Pure: the composer passes its facts in.
 */
import type { MessageKey } from '@orchardworks/agent-client';

export type ComposerMenuItemId = 'image' | 'resource' | 'command' | 'queue' | 'model' | 'permissions' | 'status';

export interface ComposerMenuFacts {
  /** The editor takes images: a rich editor with the image capability or an image draft binding. */
  readonly images: boolean;
  /** The session takes resources (files). */
  readonly resources: boolean;
  /** A resource can be uploaded now: the host gave an upload and the resource draft is restored. */
  readonly resourceUpload: boolean;
  /** There is a session to write to, or a draft-only stand-in for one. */
  readonly target: boolean;
  /** The session admits operations now: synchronized, its control check over, its runtime connected. */
  readonly ready: boolean;
  readonly readOnly: boolean;
  /** A send, queue, command, interrupt or setting change of this composer is in flight. */
  readonly busy: boolean;
  /** The previous session's history waits for the first message, which must be text sent at once. */
  readonly firstInputPending: boolean;
  /** The page offers console commands of its own, which a read-only session still runs. */
  readonly consoleCommands: boolean;
  /** Queueing for the next turn: not offered, offered but refused now, or allowed. */
  readonly queue: 'none' | 'refused' | 'allowed';
  readonly draft: {
    readonly content: boolean;
    /** The draft is a slash command. */
    readonly command: boolean;
    /** A skill is chosen for the draft. */
    readonly skill: boolean;
    /** Every image of the draft is uploaded or stored. */
    readonly imagesReady: boolean;
    /** Messages of this composer still wait to be sent. */
    readonly waiting: number;
    /** A plain message can be sent by this composer (the provider takes messages and the host gave a way to send). */
    readonly sendable: boolean;
  };
  /** The composer shows the session's settings (`settings="inline"` with an agent): Model, Permissions and Status. */
  readonly settings: boolean;
}

export interface ComposerMenuItem {
  readonly id: ComposerMenuItemId;
  readonly enabled: boolean;
  /** Why the item cannot be used, or what it does, in the reader's words. */
  readonly note?: MessageKey;
}

export function composerMenu(facts: ComposerMenuFacts): readonly ComposerMenuItem[] {
  const { draft } = facts;
  const items: ComposerMenuItem[] = [];
  if (facts.images) items.push({ id: 'image', enabled: facts.target && !facts.readOnly && !facts.busy && !facts.firstInputPending,
    ...(facts.firstInputPending ? { note: 'composer.imagesAfterHistory' } : {}) });
  if (facts.resources) items.push({ id: 'resource', enabled: facts.ready && !facts.readOnly && !facts.busy && !facts.firstInputPending && facts.resourceUpload,
    ...(facts.firstInputPending ? { note: 'composer.resourcesAfterHistory' } : {}) });
  items.push({ id: 'command', enabled: facts.ready && !facts.busy && (!facts.readOnly || facts.consoleCommands) });
  if (facts.queue !== 'none') items.push({ id: 'queue', note: facts.firstInputPending ? 'composer.queueAfterHistory' : 'composer.queueHint',
    enabled: facts.queue === 'allowed' && !facts.firstInputPending && facts.ready && !facts.busy && draft.sendable && draft.content && draft.imagesReady
      && !draft.command && !draft.skill && draft.waiting === 0 });
  if (facts.settings) items.push({ id: 'model', enabled: true }, { id: 'permissions', enabled: true }, { id: 'status', enabled: true });
  return items;
}
