import type { WindowBotDetails } from '@orchardworks/agent-remote-protocol';
import type { ProcessAssistant } from './useProcessMode.js';

/** How an assistant works: a coordinator starts tasks and talks with the account's other coordinators; a plain one is one session. */
export type AssistantMode = 'coordinator' | 'plain';
export interface AssistantModeChoice {
  readonly mode: AssistantMode;
  choose(mode: AssistantMode): void;
}

/**
 * The mode stored in the bot's details, absent meaning plain, and how to change it; undefined for a view that is no assistant, or
 * whose provider cannot be a coordinator's on its Host.
 */
export function assistantModeChoice(assistant: ProcessAssistant | undefined): AssistantModeChoice | undefined {
  if (!assistant?.coordinatorAvailable) return undefined;
  return {
    mode: assistant.details?.mode === 'coordinator' ? 'coordinator' : 'plain',
    choose(mode) {
      const { mode: _previous, ...rest }: WindowBotDetails = assistant.details ?? {};
      assistant.update(mode === 'coordinator' ? { ...rest, mode } : rest);
    },
  };
}
