import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { LiveControlPanel } from './LiveControlPanel.js';

const state = { ...replicaState, agent: { ...replicaState.agent!, status: 'idle' as const, activeTurn: null, capabilities: { ...replicaState.agent!.capabilities, commands: true, cancel: true } } };
const command = { id: 'opaque-one', name: 'native-custom', description: 'Provided at runtime', kind: 'command' as const };
async function type(container: HTMLElement, text: string) {
  const input = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function enter(container: HTMLElement) {
  await act(async () => container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
}

describe('provider command menu', () => {
  it('stages an exact skill match as a removable tag and sends only on a later submit', async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error('Try again')).mockResolvedValue({});
    const skill = { id: 'skill-one', name: 'inspect', description: 'Inspect workspace', kind: 'skill' as const };
    const container = await render(<LiveControlPanel state={state} onListCommands={async () => [skill]} onExecuteCommand={execute} />);
    await type(container, '/inspect');
    await enter(container);
    expect(execute).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')?.value).toBe('');
    expect(container.querySelector('[aria-label="View skill inspect"]')).not.toBeNull();
    await type(container, '  check\n this  ');
    await enter(container);
    expect(execute).toHaveBeenLastCalledWith('skill-one', '  check\n this  ');
    expect(container.querySelector('[aria-label="View skill inspect"]')).not.toBeNull();
    expect(container.querySelector('textarea')?.value).toBe('  check\n this  ');
    await enter(container);
    expect(container.querySelector('[aria-label="View skill inspect"]')).toBeNull();
    expect(container.querySelector('textarea')?.value).toBe('');
  });

  it('selects skills by click without dispatch and removes a tag without deleting prose', async () => {
    const execute = vi.fn();
    const skill = { id: 'skill-one', name: 'inspect', description: 'Inspect workspace', kind: 'skill' as const };
    const container = await render(<LiveControlPanel state={state} onListCommands={async () => [skill]} onExecuteCommand={execute} />);
    await type(container, '/');
    await act(async () => (container.querySelector('[role="option"]') as HTMLButtonElement).click());
    await type(container, 'keep these instructions');
    await act(async () => (container.querySelector('[aria-label="View skill inspect"]') as HTMLButtonElement).click());
    expect(container.querySelector('[aria-label="Skill details"]')?.textContent).toContain('Inspect workspace');
    expect(execute).not.toHaveBeenCalled();
    await act(async () => (container.querySelector('[aria-label="Close skill details"]') as HTMLButtonElement).click());
    await act(async () => (container.querySelector('[aria-label="Remove skill inspect"]') as HTMLButtonElement).click());
    expect(container.querySelector('textarea')?.value).toBe('keep these instructions');
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps skill drafts scoped to the session and prevents unsupported busy invocation or queueing', async () => {
    const execute = vi.fn(async () => ({}));
    const skill = { id: 'skill-one', name: 'inspect', description: 'Inspect workspace', kind: 'skill' as const };
    function Sessions() {
      const [other, setOther] = useState(false);
      const [working, setWorking] = useState(false);
      return <><button data-testid="switch" onClick={() => setOther(!other)}>Switch session</button>
        <button data-testid="work" onClick={() => setWorking(true)}>Start working</button>
        <LiveControlPanel state={{ ...state, agent: { ...state.agent, id: other ? 'other' : 'first', status: working ? 'running' : 'idle', capabilities: { ...state.agent.capabilities, queueMessage: true } } }}
          onListCommands={async () => [skill]} onExecuteCommand={execute} /></>;
    }
    const container = await render(<Sessions />);
    await type(container, '/inspect');
    await enter(container);
    await type(container, 'my instructions');
    const click = async (id: string) => act(async () => (container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click());
    await click('switch');
    expect(container.querySelector('[aria-label="Selected skill"]')).toBeNull();
    expect(container.querySelector('textarea')?.value).toBe('');
    await click('switch');
    expect(container.querySelector('[aria-label="Selected skill"]')).not.toBeNull();
    expect(container.querySelector('textarea')?.value).toBe('my instructions');
    await click('work');
    await enter(container);
    expect(execute).not.toHaveBeenCalled();
    expect((container.querySelector('[data-testid="prompt-submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('[data-testid="queue-submit"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('loads native descriptors and invokes the opaque ID without sending a model message', async () => {
    const execute = vi.fn(async () => ({ text: 'Native complete' }));
    const send = vi.fn();
    const container = await render(<LiveControlPanel state={state} onListCommands={async () => [command]} onExecuteCommand={execute} onSendMessage={send} />);
    await type(container, '/');
    expect(container.querySelector('[role="option"]')?.textContent).toContain('/native-custom');
    expect(container.textContent).not.toContain('/status');
    await enter(container);
    expect(execute).toHaveBeenCalledWith('opaque-one', '');
    expect(send).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Native complete');
  });

  it('preserves command arguments and rejects unknown slash input', async () => {
    const execute = vi.fn(async () => ({}));
    const send = vi.fn();
    const container = await render(<LiveControlPanel state={state} onListCommands={async () => [{ ...command, inputHint: '<text>' }]} onExecuteCommand={execute} onSendMessage={send} />);
    await type(container, '/native-custom  one  two\nthree');
    await enter(container);
    expect(execute).toHaveBeenCalledWith(command.id, '  one  two\nthree');
    await type(container, '/unknown');
    await enter(container);
    expect(send).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Unknown');
    expect(container.querySelector('textarea')?.value).toBe('/unknown');
  });

  it('refreshes descriptors on reopen and surfaces discovery failures', async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error('Native discovery failed')).mockResolvedValue([command]);
    const container = await render(<LiveControlPanel state={state} onListCommands={list} onExecuteCommand={async () => ({})} />);
    await type(container, '/');
    expect(container.textContent).toContain('Native discovery failed');
    await act(async () => (container.querySelector('[data-testid="retry-commands"]') as HTMLButtonElement).click());
    expect(container.querySelector('[role="option"]')?.textContent).toContain(command.name);
    await type(container, 'ordinary draft');
    await type(container, '/');
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('interrupts a pending native command without an active turn and keeps send blocked until completion', async () => {
    let finish!: (result: {}) => void;
    const cancel = vi.fn(async () => {});
    const container = await render(<LiveControlPanel state={state} onListCommands={async () => [command]}
      onExecuteCommand={() => new Promise((resolve) => { finish = resolve; })} onCancel={cancel} />);
    await type(container, '/');
    await enter(container);
    expect(container.textContent).toContain('Executing command');
    const interrupt = container.querySelector('[data-testid="cancel-submit"]') as HTMLButtonElement;
    expect(interrupt.disabled).toBe(false);
    await act(async () => interrupt.click());
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(interrupt.disabled).toBe(true);
    expect(container.querySelector('textarea')?.disabled).toBe(true);
    await act(async () => finish({}));
    expect(container.querySelector('textarea')?.disabled).toBe(false);
  });

  it('dismisses loading and empty command menus with Escape', async () => {
    let finish!: (commands: typeof command[]) => void;
    const container = await render(<LiveControlPanel state={state} onListCommands={() => new Promise((resolve) => { finish = resolve; })} />);
    const escape = async () => act(async () => container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await type(container, '/');
    expect(container.textContent).toContain('Loading native commands');
    await escape();
    expect(container.textContent).not.toContain('Loading native commands');
    await type(container, '/missing');
    await act(async () => finish([]));
    expect(container.textContent).toContain('No matching native commands');
    await escape();
    expect(container.textContent).not.toContain('No matching native commands');
  });

  it('ignores a late directory response from a different session', async () => {
    let finish!: (commands: typeof command[]) => void;
    function Sessions() {
      const [other, setOther] = useState(false);
      return <><button onClick={() => setOther(true)}>Switch</button><LiveControlPanel state={other ? { ...state, agent: { ...state.agent, id: 'other' } } : state}
        onListCommands={() => new Promise((resolve) => { finish = resolve; })} onExecuteCommand={async () => ({})} /></>;
    }
    const container = await render(<Sessions />);
    await type(container, '/');
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
    await act(async () => finish([command]));
    expect(container.querySelector('[role="option"]')).toBeNull();
    expect(container.querySelector('textarea')?.value).toBe('');
  });
});
