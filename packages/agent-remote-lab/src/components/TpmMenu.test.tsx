import { act, useRef } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { TpmWork } from '@orchardworks/agent-remote-protocol';
import { render } from '../test/setup.js';
import { useTpmWork, type TpmService } from '../hooks/useTpmWork.js';
import { TpmMenu } from './TpmMenu.js';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { vi.unstubAllGlobals(); });
const main = { hostId: 'host', providerId: 'codex', nativeSessionId: 'main', title: 'Main session' };
const work: TpmWork = { id: 'work', revision: 1, title: 'Search delivery', providerId: 'codex', mainNativeSessionId: 'main', tpmNativeSessionId: 'tpm', phase: 'validating', waiting: 'user', paused: false, summary: 'Review acceptance', nextAction: 'Choose scope', document: '# Search', acceptance: '- [ ] Query items', evidence: [], createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', nextCheckAt: 100 };
function harness(catalog: { supported: boolean; works: TpmWork[]; supportedProviders?: string[] }) {
  const creates: unknown[] = [];
  const service: TpmService = { tpmWork: async () => work, tpmList: async () => catalog,
    tpmCreate: async (host, input) => { creates.push({ host, ...input }); return work; }, tpmAction: async () => work };
  let state!: ReturnType<typeof useTpmWork>;
  function Harness() {
    const trigger = useRef<HTMLButtonElement>(null);
    state = useTpmWork(service, [{ id: 'host', name: 'Host', online: true }], true, async value => ({ ...value, agentId: 'tpm-agent' }));
    return <TpmMenu tpm={state} main={main} visible triggerRef={trigger} inert={false} />;
  }
  return { Harness, creates, state: () => state };
}
it('opens a global work without changing the main view and distinguishes delivery phase from needs-user state', async () => {
  const h = harness({ supported: true, supportedProviders: ['codex'], works: [work] });
  const container = await render(<h.Harness />);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="TPM works"]')!.click());
  expect(container.textContent).toContain('Validating');
  expect(container.textContent).toContain('Needs you');
  expect(container.textContent).toContain('Host');
  await act(async () => container.querySelector<HTMLButtonElement>('[data-tpm-work]')!.click());
  expect(h.state().expanded).toBe(true);
  expect(h.state().sessions[h.state().selected!]!.nativeSessionId).toBe('tpm');
  expect(h.creates).toEqual([]);
});
it('creates a work from the selected main with a title and requirement', async () => {
  const h = harness({ supported: true, supportedProviders: ['codex'], works: [] });
  const container = await render(<h.Harness />);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="TPM works"]')!.click());
  expect(container.textContent).toContain('No TPM works yet');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Create TPM work"]')!.click());
  for (const [label, value] of [['Work title', 'Search'], ['Requirement', 'Find items']] as const) {
    const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
    await act(async () => { Object.getOwnPropertyDescriptor(label === 'Requirement' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
  }
  await act(async () => container.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(h.creates).toMatchObject([{ host: 'host', providerId: 'codex', mainNativeSessionId: 'main', title: 'Search', requirement: 'Find items' }]);
  expect(h.state().expanded).toBe(true);
});
it('explains an unavailable Controller without offering misleading creation', async () => {
  const h = harness({ supported: false, works: [] });
  const container = await render(<h.Harness />);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="TPM works"]')!.click());
  expect(container.textContent).toContain('TPM is unavailable');
  expect(container.querySelector('[aria-label="Create TPM work"]')).toBeNull();
});
