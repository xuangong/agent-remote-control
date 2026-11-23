/**
 * Which actions a context menu offers (I5d): one rule per menu, so a right-click, Shift-F10 and the ⋯ menus agree. Pure.
 *
 * A chat (an assistant in Chats or the directory): pin or unpin, mute or unmute and rename; an assistant that can move (not a
 * Side, which moves with the assistant it is beside, nor a Team or Support member) also moves to a group, and leaves the
 * group it is in unless that is the default group.
 *
 * A message: copy and quote any message with text, the person's or the assistant's reply; resend the person's message that was
 * not sent. The browser's own menu stays where it serves the reader better: on a link, over text the reader selected in that
 * message (selecting and copying text never fights the page), and on anything that is no message, such as a step of the work.
 */

export type ChatMenuItem = 'pin' | 'unpin' | 'mute' | 'unmute' | 'rename' | 'move' | 'leaveGroup';
export interface ChatMenuFacts {
  readonly pinned: boolean; readonly muted: boolean;
  /** It is no Side and has no Team or Support role. */
  readonly movable: boolean;
  /** It is in a group people made, not the default group. */
  readonly grouped: boolean;
}

export function chatMenu({ pinned, muted, movable, grouped }: ChatMenuFacts): readonly ChatMenuItem[] {
  return [pinned ? 'unpin' : 'pin', muted ? 'unmute' : 'mute', 'rename', ...(movable ? ['move' as const] : []), ...(movable && grouped ? ['leaveGroup' as const] : [])];
}

export type MessageMenuItem = 'copy' | 'quote' | 'resend';
export interface MessageMenuFacts {
  /** The person's message (sent or on its way), the assistant's reply, the person's message that was not sent, or no message. */
  readonly kind: 'mine' | 'reply' | 'unsent' | 'other';
  readonly hasText: boolean;
  /** The reader selected text inside this message. */
  readonly selectedInside: boolean;
  /** The press is on a link. */
  readonly onLink: boolean;
  /** The conversation's composer takes text now. */
  readonly canQuote: boolean;
  /** The page can send a message again. */
  readonly canResend: boolean;
}

/** The message's actions, or `native` where the browser's own menu shows. */
export function messageMenu(facts: MessageMenuFacts): readonly MessageMenuItem[] | 'native' {
  if (facts.onLink || facts.selectedInside || facts.kind === 'other') return 'native';
  const items: MessageMenuItem[] = [
    ...(facts.hasText ? ['copy' as const] : []),
    ...(facts.hasText && facts.canQuote ? ['quote' as const] : []),
    ...(facts.kind === 'unsent' && facts.canResend ? ['resend' as const] : []),
  ];
  return items.length ? items : 'native';
}
