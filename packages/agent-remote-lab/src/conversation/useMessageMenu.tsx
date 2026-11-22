// A message's context menu: a right-click, Shift-F10 or the context menu key on a message offers what the message menu rule
// (kernel/context-menus.ts) allows: Copy with its formatting, Quote into this conversation's composer, and Resend for a message
// that was not sent. Elsewhere, and over a link or text the reader selected, the browser's own menu shows.
import { useMemo, useRef, type PointerEvent, type ReactNode } from 'react';
import { timelineEntryKey, type AgentReplicaState } from '@orchardworks/agent-client';
import { copyMessage, useTranslate } from '@orchardworks/agent-client-web/react';
import { messageMenu, type MessageMenuFacts } from '../kernel/context-menus.js';
import { useToast } from '../kernel/Toast.js';
import { contextMenuEvents, useContextMenu } from '../ui/ContextMenu.js';
import type { MenuEntry } from '../ui/Menu.js';

/** The message a timeline row shows: the person's (sent, on its way or not sent) or the assistant's reply, or no message. */
export function messageOfRow(row: HTMLElement, state: AgentReplicaState | undefined): { kind: MessageMenuFacts['kind']; text: string; id: string } {
  const id = row.dataset.entryKey ?? '';
  if (row.classList.contains('agent-outgoing-message')) {
    const message = state?.outgoingMessages?.find(item => item.id === id);
    const settled = row.dataset.deliveryState === 'failed' || row.dataset.deliveryState === 'unconfirmed';
    return { kind: settled ? 'unsent' : 'mine', text: message?.text ?? '', id };
  }
  const item = state?.timeline.entries.find(entry => timelineEntryKey(entry) === id)?.item;
  if (item?.type === 'user_message') return { kind: 'mine', text: item.text, id };
  if (item?.type === 'assistant_message') return { kind: 'reply', text: item.text, id };
  return { kind: 'other', text: '', id };
}

function selectedWithin(row: Element): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
  for (let index = 0; index < selection.rangeCount; index++) if (selection.getRangeAt(index).intersectsNode(row)) return true;
  return false;
}

export function useMessageMenu({ state, onQuote, onResend }: { state?: AgentReplicaState; onQuote?(text: string): void; onResend?(id: string): Promise<void> }): {
  events: ReturnType<typeof contextMenuEvents> & { onPointerDownCapture(event: PointerEvent<HTMLElement>): void }; menu: ReactNode } {
  const t = useTranslate();
  const toast = useToast();
  const context = useContextMenu();
  const latest = useRef({ state, onQuote, onResend, t, toast, show: context.show });
  latest.current = { state, onQuote, onResend, t, toast, show: context.show };
  // Safari selects the word under a right-click as it presses: what counts is the text the reader selected before pressing.
  const pressed = useRef<{ row: Element; selected: boolean }>();
  const events = useMemo(() => ({ ...contextMenuEvents(({ target, point }) => {
    const row = target.closest<HTMLElement>('[data-entry-key]');
    if (!row) return false;
    const { state, onQuote, onResend, t, toast, show } = latest.current;
    const message = messageOfRow(row, state);
    const before = point && pressed.current?.row === row ? pressed.current.selected : undefined;
    pressed.current = undefined;
    const items = messageMenu({ kind: message.kind, hasText: !!message.text.trim(), selectedInside: before ?? selectedWithin(row), onLink: !!target.closest('a[href]'),
      canQuote: !!onQuote, canResend: !!onResend });
    if (items === 'native') return false;
    const entries = items.map((item): MenuEntry => item === 'copy'
      ? { label: t('common.copy'), icon: 'copy', onSelect: () => void copyMessage(message.text, row).then(() => toast?.show('message-copy', t('common.copied'), t('conversation.copiedNote'), 'info'),
        () => toast?.show('message-copy', t('common.copyFailed'), t('conversation.copyFailedNote'), 'error')) }
      : item === 'quote' ? { label: t('conversation.quote'), icon: 'quote', onSelect: () => onQuote?.(message.text) }
      : { label: t('conversation.resend'), icon: 'refresh', onSelect: () => void onResend?.(message.id).catch(() => undefined) });
    const focused = document.activeElement instanceof HTMLElement && row.contains(document.activeElement) ? document.activeElement : undefined;
    show(row, t('conversation.messageActions'), entries, point, focused ?? row.closest<HTMLElement>('[tabindex]') ?? row);
    return true;
  }), onPointerDownCapture(event: PointerEvent<HTMLElement>) {
    const row = event.button === 2 ? (event.target as Element).closest('[data-entry-key]') : null;
    pressed.current = row ? { row, selected: selectedWithin(row) } : undefined;
  } }), []);
  return { events, menu: context.menu };
}
