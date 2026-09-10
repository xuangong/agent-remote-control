import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { LiveControlPanel } from './LiveControlPanel.js';

const state = { ...replicaState, agent: { ...replicaState.agent!, status: 'idle' as const, activeTurn: null,
  capabilities: { ...replicaState.agent!.capabilities, sessionSettings: true },
  runtimeInfo: { ...replicaState.agent!.runtimeInfo, settings: [
    { id: 'model', category: 'model' as const, label: 'Model', value: 'a', options: [{ value: 'a', label: 'Model A' }, { value: 'b', label: 'Model B' }], mutable: true, scope: 'session' as const },
    { id: 'permissions', category: 'permissions' as const, label: 'Permissions', value: 'ask', options: [{ value: 'ask', label: 'Ask' }, { value: 'auto', label: 'Auto' }], mutable: true, scope: 'session_and_default' as const },
  ] },
} };

describe('chat session settings', () => {
  it('keeps the confirmed selection until the Provider changes it and prevents duplicate submissions', async () => {
    let finish!: () => void;
    const updates: string[] = [];
    function Session() {
      const [current, setCurrent] = useState(state);
      return <LiveControlPanel state={current} onSetSessionSetting={async (id, value) => {
        updates.push(`${id}:${value}`);
        await new Promise<void>((resolve) => { finish = resolve; });
        setCurrent({ ...state, agent: { ...state.agent, runtimeInfo: { ...state.agent.runtimeInfo, settings: state.agent.runtimeInfo.settings.map((setting) => setting.id === id ? { ...setting, value } : setting) } } });
      }} />;
    }
    const container = await render(<Session />);
    await act(async () => (container.querySelector('[data-testid="session-model-button"]') as HTMLButtonElement).click());
    const select = container.querySelector('[data-testid="session-setting-model"]') as HTMLSelectElement;
    await act(async () => { select.value = 'b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(updates).toEqual(['model:b']);
    expect(select.disabled).toBe(true);
    expect(select.value).toBe('a');
    await act(async () => finish());
    expect(select.value).toBe('b');
    expect(select.disabled).toBe(false);
  });

  it('unlocks after acknowledgement even when another native update supersedes the requested value', async () => {
    let finish!: () => void;
    const container = await render(<LiveControlPanel state={state} onSetSessionSetting={() => new Promise<void>((resolve) => { finish = resolve; })} />);
    await act(async () => (container.querySelector('[data-testid="session-model-button"]') as HTMLButtonElement).click());
    const select = container.querySelector('[data-testid="session-setting-model"]') as HTMLSelectElement;
    await act(async () => { select.value = 'b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(select.disabled).toBe(true);
    await act(async () => finish());
    expect(select.value).toBe('a');
    expect(select.disabled).toBe(false);
  });

  it('reports native rejection and allows retry without changing the confirmed value', async () => {
    const selectSetting = vi.fn().mockRejectedValue(new Error('Native setting refused.'));
    const container = await render(<LiveControlPanel state={state} onSetSessionSetting={selectSetting} />);
    await act(async () => (container.querySelector('[data-testid="session-model-button"]') as HTMLButtonElement).click());
    const select = container.querySelector('[data-testid="session-setting-model"]') as HTMLSelectElement;
    await act(async () => { select.value = 'b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Native setting refused.');
    expect(select.value).toBe('a');
    expect(select.disabled).toBe(false);
  });

  it('isolates an in-flight setting response when switching sessions', async () => {
    let reject!: (error: Error) => void;
    function Sessions() {
      const [other, setOther] = useState(false);
      return <><button onClick={() => setOther(true)}>Switch session</button><LiveControlPanel
        state={other ? { ...state, agent: { ...state.agent, id: 'other-agent' } } : state}
        onSetSessionSetting={() => new Promise<void>((_resolve, fail) => { reject = fail; })} /></>;
    }
    const container = await render(<Sessions />);
    const openModel = async () => act(async () => (container.querySelector('[data-testid="session-model-button"]') as HTMLButtonElement).click());
    await openModel();
    const select = container.querySelector('[data-testid="session-setting-model"]') as HTMLSelectElement;
    await act(async () => { select.value = 'b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
    await openModel();
    await act(async () => reject(new Error('Old session refused.')));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect((container.querySelector('[data-testid="session-setting-model"]') as HTMLSelectElement).value).toBe('a');
    expect((container.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('shows current permissions while disabling changes for disconnected or busy sessions', async () => {
    for (const props of [{ state, disabled: true }, { state: { ...state, agent: { ...state.agent, status: 'running' as const } } }]) {
      const container = await render(<LiveControlPanel {...props} onSetSessionSetting={async () => {}} />);
      await act(async () => (container.querySelector('[data-testid="session-permissions-button"]') as HTMLButtonElement).click());
      const select = container.querySelector('[data-testid="session-setting-permissions"]') as HTMLSelectElement;
      expect(select.value).toBe('ask');
      expect(select.disabled).toBe(true);
    }
  });
});
