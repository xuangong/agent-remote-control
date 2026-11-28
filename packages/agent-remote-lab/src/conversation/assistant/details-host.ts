import { createContext } from 'react';
import type { WindowBotDetails } from '@orchardworks/agent-remote-protocol';
import type { MenuEntry } from '../../ui/Menu.js';
import type { CardAction } from './AssistantCard.js';

/** Where an assistant runs, as its place knows it: the Host's name and whether it is online, the agent and the agents before a handoff. */
export interface AssistantWhere { readonly host: string; readonly online?: boolean; readonly provider: string; readonly earlier: readonly string[] }

/**
 * Where an assistant's details open and what its place adds to them. Bot mode provides the details panel beside the
 * conversation, or a sheet on a phone; a Window tile opens them over its window. The conversation renders the details
 * itself, since the process mode, the settings and the files come from its session.
 */
export interface AssistantDetailsHost {
  readonly surface: 'panel' | 'sheet';
  /** The panel the details go into; a sheet needs none. */
  readonly slot?: HTMLElement | null;
  readonly open: boolean;
  setOpen(open: boolean): void;
  /** The card's actions, which the assistant's place owns: one visible (Pin to a workbench), the others in its ⋯ menu (Label…, Sleep or Wake, Hide, Remove). */
  readonly action?: CardAction;
  readonly actions?: readonly MenuEntry[];
  /** Stores a new avatar for the assistant, on every device. */
  readonly setPicture?: (picture: NonNullable<WindowBotDetails['picture']>) => void;
  /** Stores the assistant's own name, on every device; absent where it cannot be stored (a session in no group). */
  readonly rename?: (name: string) => void;
  readonly where?: AssistantWhere;
  /** The assistant's newest reply as its list row has it: a conversation not loaded yet shows it as its last bubble. */
  readonly latestReply?: string;
  /** A place in the host's top bar for the conversation's own tools (its search). */
  readonly tools?: HTMLElement | null;
}

export const AssistantDetailsHostContext = createContext<AssistantDetailsHost | undefined>(undefined);
