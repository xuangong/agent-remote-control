import { createContext, useContext } from 'react';
import type { Board, BoardItem, BoardItemEdit, BoardPlanEdit, BoardWriteResult, TaskView } from '@orchardworks/agent-remote-protocol';

/** One thing the person asked a bot from a conversation (a mention) and what it answered, if it has. */
export interface AskLine { readonly id: string; readonly botId: string; readonly bot: string; readonly text: string; readonly at: number; readonly answer?: { readonly text: string; readonly at: number } }
/** What a `/side` bot answered the conversation it was asked from: a card beside it, which the person may bring back into it. */
export interface SideCard { readonly taskId: string; readonly title: string; readonly status: 'done' | 'failed'; readonly summary: string; readonly at: number }
/** An answer session a bot has open: the conversation it answers, when it was last asked and how many questions it holds. */
export interface AnswerSession { readonly teamId: string; readonly conversation: string; readonly lastAt: number; readonly count: number }
/**
 * What the page knows about sub-sessions, for their cards: whether a sub-session's session can be opened, and opening it. The page supplies it;
 * without it a card shows the sub-session without the action.
 */
export interface TaskDirectory {
  canOpen(taskId: string): boolean;
  open(taskId: string): void;
  /** The tasks a session owns, newest first. */
  owned(owner: { providerId: string; nativeSessionId: string }): readonly TaskView[];
  /** A bot's standing staff: the bots it created and is chief of (bots design 10). */
  staff?(botId: string): readonly { botId: string; name: string }[];
  /** The items of a standing bot's board, newest first (bots design 6). */
  board?(bot: { providerId: string; nativeSessionId: string }): readonly BoardItem[];
  /** A standing bot's whole board, its plan note and items, by the bot's id; what the page shows of it is read only except on the bot's own details. */
  boardOf?(botId: string): Board | undefined;
  /** The name of a bot an item names as its assignee: a standing bot, or a temporary bot. */
  botName?(botId: string): string | undefined;
  /** The bots the person may assign an item of this bot's board to besides the bot itself: its standing staff and its temporary bots at work. */
  assignees?(botId: string): readonly { botId: string; name: string }[];
  /** Whether the session or bot doing an item can be opened from the page, and opening it: a standing bot's conversation, or a temporary bot beside its chief. */
  canOpenBot?(botId: string): boolean;
  openBot?(botId: string): void;
  /** The person edits a standing bot's items and plan note; the Relay tells the bots the edit changes, and the answer says what a stale edit overwrote. */
  writeBoard?(botId: string, edit: { items?: readonly BoardItemEdit[]; plan?: BoardPlanEdit }): Promise<BoardWriteResult>;
  /** Who manages a standing bot now (undefined: the person) and the standing bots it may be moved to. */
  chief?(botId: string): { current?: { botId: string; name: string }; choices: readonly { botId: string; name: string }[] };
  /** The person moves a standing bot to another chief, or to themselves (null); the Relay tells the bots. */
  setChief?(botId: string, chief: string | null): Promise<void>;
  /** The standing bots of the account, which a mention can ask (bots plan 8d). */
  bots?(): readonly { botId: string; name: string }[];
  /** The person asks a bot from a conversation: the bot answers in its answer session for that conversation, and nothing reaches the conversation's own session. */
  ask?(source: { hostId: string; providerId: string; nativeSessionId: string; title: string }, bot: { botId: string; name: string }, text: string): Promise<void>;
  /** What the person asked bots from this conversation and what they answered, oldest first (bots plan 8d). */
  asks?(from: { providerId: string; nativeSessionId: string }): readonly AskLine[];
  /** The `/side` bots asked from this conversation that have reported, oldest first (bots plan 9a). They never reach the conversation's own session as input. */
  sides?(from: { providerId: string; nativeSessionId: string }): readonly SideCard[];
  /** The person brings a side's answer into the conversation `agentId` as their own input. */
  bringBack?(card: SideCard, agentId: string): Promise<void>;
  /** The answer sessions a standing bot has open now, newest first. */
  answering?(botId: string): readonly AnswerSession[];
  /** The person ends a sub-session: its running turn stops and its session is released. */
  act(taskId: string, action: 'stop_sub_session'): Promise<void>;
}
export const TaskDirectoryContext = createContext<TaskDirectory | undefined>(undefined);
export const useTaskDirectory = (): TaskDirectory | undefined => useContext(TaskDirectoryContext);
