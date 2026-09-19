import { act, StrictMode, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { HttpWebSocketTransport } from '@agent-remote-controller/agent-remote-web';
import { App, type LabTransport } from './App.js';
import { replicaState } from './test/fixtures.js';
import { render } from './test/setup.js';

vi.mock('@agent-remote-controller/agent-remote-web', async importOriginal => {
  const original = await importOriginal<typeof import('@agent-remote-controller/agent-remote-web')>();
  return { ...original, HttpWebSocketTransport: vi.fn(function () {
    return { dispose: vi.fn(), connect: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })),
      onDiagnostic: () => () => {}, onProtocolMessage: () => () => {} };
  }) };
});
afterEach(() => { vi.clearAllMocks(); localStorage.clear(); });

it('opts owned transports into channels and disposes replacements and unmounts without disposing a StrictMode reuse', async () => {
  let changeScope!: (value: string) => void;
  let hide!: () => void;
  function Harness() {
    const [scope, setScope] = useState('alice'); changeScope = setScope;
    const [visible, setVisible] = useState(true); hide = () => setVisible(false);
    return visible ? <App baseUrl={`http://localhost/u/${scope}/`} initialState={replicaState} /> : null;
  }
  await render(<StrictMode><Harness /></StrictMode>);
  const constructor = vi.mocked(HttpWebSocketTransport);
  expect(constructor).toHaveBeenLastCalledWith('http://localhost/u/alice/', { sessionChannels: true });
  const first = constructor.mock.results.at(-1)!.value as HttpWebSocketTransport;
  expect(first.dispose).not.toHaveBeenCalled();
  await act(async () => changeScope('bob'));
  expect(first.dispose).toHaveBeenCalledOnce();
  const next = constructor.mock.results.at(-1)!.value as HttpWebSocketTransport;
  expect(next.dispose).not.toHaveBeenCalled();
  await act(async () => hide());
  expect(next.dispose).toHaveBeenCalledOnce();
});

it('leaves an injected transport under its caller ownership', async () => {
  const dispose = vi.fn();
  const transport = { dispose, connect: () => ({ send() {}, close() {} }), onDiagnostic: () => () => {}, onProtocolMessage: () => () => {} } as unknown as LabTransport;
  let hide!: () => void;
  function Harness() {
    const [visible, setVisible] = useState(true); hide = () => setVisible(false);
    return visible ? <App transport={transport} initialState={replicaState} /> : null;
  }
  await render(<StrictMode><Harness /></StrictMode>);
  await act(async () => hide());
  expect(HttpWebSocketTransport).not.toHaveBeenCalled();
  expect(dispose).not.toHaveBeenCalled();
});
