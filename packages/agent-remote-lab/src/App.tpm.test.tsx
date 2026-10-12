import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App.js';
import type { LabTransport } from './App.js';
import type { TpmWork } from '@orchardworks/agent-remote-protocol';
import { SessionDirectoryClient } from './directory-client.js';
import { replicaState } from './test/fixtures.js';
import { render, setPromptText, promptText } from './test/setup.js';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); });
it('runs TPM commands locally from the ordinary chatbox and exposes an independent View-menu choice', async () => {
  const sendMessage = vi.fn(async () => {});
  const container = await render(<App initialState={replicaState} initialSessionStatus="ready" actions={{ sendMessage }} />);
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
  await act(async () => {
    setPromptText(input, '/tpm on');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
  expect(container.querySelector<HTMLElement>('.lab-tpm-floating')?.hidden).toBe(false);
  expect(sendMessage).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="View options"]')!.click());
  const choice = container.querySelector<HTMLInputElement>('[aria-label="TPM view"]');
  expect(choice?.checked).toBe(true);
  await act(async () => choice!.click());
  expect(container.querySelector<HTMLElement>('.lab-tpm-floating')?.hidden).toBe(true);
  expect(localStorage.getItem('agent-remote:tpm-view')).toBe('false');
});

it.each(['fixed', 'legacy', 'role', 'stale-role', 'missing-provider'] as const)('opens TPM main from its validated reference for %s work', async mode => {
  const scope = `http://localhost/u/tpm-main-${mode}/`;
  localStorage.setItem('agent-remote:tpm-view', 'true');
  const ref = { controllerId: 'installation', providerId: 'main-provider', nativeSessionId: 'B' };
  const work: TpmWork = { id: 'work', revision: 1, title: 'Independent TPM work', providerId: 'tpm-provider', mainNativeSessionId: 'B',
    phase: 'clarifying', waiting: 'none', paused: false, summary: '', nextAction: '', document: 'Retained TPM document', acceptance: '', evidence: [],
    createdAt: '2026-10-10', updatedAt: '2026-10-10', nextCheckAt: 0,
    ...(mode === 'legacy' ? {} : { mainSessionRef: ref, mainBinding: mode.includes('role') ? { kind: 'primary_role', roleId: 'primary', origin: { ...ref, providerId: 'retired-provider', nativeSessionId: 'A' } } : { kind: 'fixed', source: ref } }),
  };
  const list = vi.fn(async () => ({ supported: true, works: [work] }));
  const current = vi.fn(async () => ({ version: 1 as const, role: { id: 'primary', revision: mode === 'stale-role' ? 3 : 2, origin: { ...ref, nativeSessionId: 'A' }, current: { ...ref, nativeSessionId: mode === 'stale-role' ? 'C' : 'B' }, workspace: { controllerId: 'installation', canonicalCwd: '/fixture' } }, locator: { hostId: 'host', providerId: ref.providerId, nativeSessionId: mode === 'stale-role' ? 'C' : 'B' } }));
  const attach = vi.spyOn(SessionDirectoryClient.prototype, 'attach').mockRejectedValue(new Error('Fixture main is offline'));
  vi.spyOn(SessionDirectoryClient.prototype, 'list').mockImplementation(async providerId => ({ items: [{ providerId, nativeSessionId: 'B', title: 'Main project', createdAt: '', updatedAt: '', state: 'idle' }], revision: '1', hasMore: false }));
  vi.spyOn(SessionDirectoryClient.prototype, 'workspaces').mockResolvedValue({ workspaces: [] });
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, fetchSessionSuccessionCurrent: current } as unknown as LabTransport;
  const hostService = { hosts: async () => ({ hosts: [{ id: 'host', name: 'Fixture', online: true, providers: [{ providerId: 'tpm-provider', displayName: 'TPM' }, ...(mode === 'missing-provider' ? [] : [{ providerId: ref.providerId, displayName: 'Main' }])] }] }),
    pair: async () => { throw new Error('No pairing'); }, revoke: async () => {}, tpmList: list, tpmWork: async () => work,
    tpmCreate: async () => { throw new Error('No work creation'); }, tpmAction: async () => { throw new Error('No work mutation'); } };
  const view = await render(<App initialState={replicaState} initialSessionStatus="ready" baseUrl={scope} userScoped transport={transport}
    directory={new SessionDirectoryClient(scope, undefined, 'host')} hostService={hostService} />);
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="TPM works"]')!.click());
  await vi.waitFor(() => expect(view.querySelector('[data-tpm-work]')).not.toBeNull());
  await act(async () => view.querySelector<HTMLButtonElement>('[data-tpm-work]')!.click());
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Close TPM works"]')!.click());
  const mainLink = view.querySelector<HTMLButtonElement>('[aria-label^="Open main session:"]')!;
  expect(mainLink.textContent).toContain('Main project');
  expect(mainLink.title).toContain(mode === 'legacy' ? work.providerId : ref.providerId);
  expect(attach).not.toHaveBeenCalled();
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Dock Independent TPM work"]')!.click());
  const dock = view.querySelector('[data-dock-id]');
  await act(async () => mainLink.click());
  expect(view.querySelector('[data-dock-id]')).toBe(dock);
  expect(dock?.isConnected).toBe(true);
  if (mode === 'stale-role' || mode === 'missing-provider') {
    expect(attach).not.toHaveBeenCalled();
    expect(view.textContent).toContain(mode === 'stale-role' ? 'TPM has been refreshed' : 'provider is unavailable');
    expect(view.textContent).toContain(work.title);
    if (mode === 'stale-role') expect(list.mock.calls.length).toBeGreaterThan(1);
  } else expect(attach.mock.calls.map(([provider, native]) => [provider, native])).toEqual([[mode === 'legacy' ? work.providerId : ref.providerId, 'B']]);
  expect(current).toHaveBeenCalledTimes(mode.includes('role') ? 1 : 0);
  expect(work.document).toBe('Retained TPM document');
});
