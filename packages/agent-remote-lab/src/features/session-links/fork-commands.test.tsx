// The conversation commands the composer offers for branching: /side and its alias /btw open a Side, /fork a fork, /ask an Ask.
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { AgentComposer } from '@orchardworks/agent-client-web/react';
import { remoteSessionState, type AgentReplicaState } from '@orchardworks/agent-client';
import { replicaState } from '../../test/fixtures.js';
import { forkCommands } from '../../conversation/fork-actions.js';
import { render } from '../../test/setup.js';

const state: AgentReplicaState = { ...replicaState, agent: { ...replicaState.agent!, status: 'idle', activeTurn: null } };

async function submit(draft: string) {
  const execute = vi.fn(async (_id: string, _args: string) => ({}));
  const send = vi.fn(async () => {});
  const view = await render(<AgentComposer sessionState={remoteSessionState(state, 'ready')} state={state} draft={draft} onSendMessage={send}
    consoleCommands={forkCommands} onExecuteConsoleCommand={execute} />);
  await act(async () => view.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
  return { execute, send };
}

it.each([['/side Tell me about the branch'], ['/btw Tell me about the branch']])('runs %s as the Side command with the text after it', async draft => {
  const { execute, send } = await submit(draft);
  expect(execute).toHaveBeenCalledWith('console:side', ' Tell me about the branch');
  expect(send).not.toHaveBeenCalled();
});

it.each([['/fork', 'console:fork'], ['/ask why', 'console:ask']])('runs %s as its own command', async (draft, id) => {
  const { execute } = await submit(draft);
  expect(execute.mock.calls[0]![0]).toBe(id);
});
