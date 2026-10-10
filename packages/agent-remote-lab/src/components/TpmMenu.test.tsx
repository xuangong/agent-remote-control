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
it('creates and opens a TPM session directly without requiring a title or requirement', async () => {
  const h = harness({ supported: true, supportedProviders: ['codex'], works: [] });
  const container = await render(<h.Harness />);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="TPM works"]')!.click());
  expect(container.querySelector('[aria-label="Refresh TPM works"]')).toBeNull();
  expect(container.querySelector('form')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Create TPM work"]')!.click());
  expect(h.creates).toEqual([{ host: 'host', providerId: 'codex', mainNativeSessionId: 'main', operationId: expect.any(String) }]);
  expect(h.state().expanded).toBe(true);
  expect(h.state().sessions[h.state().selected!]!.nativeSessionId).toBe('tpm');
});
it('explains an unavailable Controller without offering misleading creation', async () => {
  const h = harness({ supported: false, works: [] });
  const container = await render(<h.Harness />);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="TPM works"]')!.click());
  expect(container.textContent).toContain('TPM is unavailable');
  expect(container.querySelector('[aria-label="Create TPM work"]')).toBeNull();
});

it('keeps archived sessions accessible without counting them as active or showing attention', async () => {
  const h = harness({ supported: true, supportedProviders: ['codex'], works: [{ ...work, archived: true, phase: 'completed', waiting: 'none' }] });
  const container = await render(<h.Harness />);
  expect(container.querySelector('.lab-tpm-count')!.textContent).toBe('0');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="TPM works"]')!.click());
  const archive = container.querySelector<HTMLDetailsElement>('.lab-tpm-archived')!;
  expect(archive.open).toBe(false);
  expect(archive.textContent).toContain('Archived (1)');
  expect(container.querySelector('.lab-tpm-panel > .lab-tpm-list')!.children.length).toBe(0);
  await act(async () => archive.querySelector('summary')!.click());
  await act(async () => archive.querySelector<HTMLButtonElement>('[data-tpm-work]')!.click());
  expect(h.state().expanded).toBe(true);
});
