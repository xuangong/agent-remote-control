import { createContext } from 'react';
import type { WorkspaceWindow } from '@orchardworks/agent-remote-protocol';

/** What the places that start, bind or open bot workbenches need: the bots, the Window's binding, and the actions that run them. */
export interface BotWorkbenchActions {
  /** The standing bots a workbench can follow, with the names people call them. */
  readonly bots: readonly { readonly botId: string; readonly name: string }[];
  /** The bot a Window follows, when it is a bot workbench. */
  boundTo(window: Pick<WorkspaceWindow, 'views'>): { readonly botId: string; readonly name: string } | undefined;
  /** Opens the bot's workbench in Window mode: the one this device used last, or a new one. */
  openWorkbench(botId: string): Promise<void>;
  /** Asks for the new-workbench choice, the bind choice or the unbind confirmation. */
  request(sheet: 'new' | 'bind' | 'unbind'): void;
}
export const BotWorkbenchContext = createContext<BotWorkbenchActions | undefined>(undefined);
