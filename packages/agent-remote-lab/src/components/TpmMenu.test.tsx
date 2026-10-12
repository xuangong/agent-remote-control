import { act, useRef, useState } from 'react';
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
  const service: TpmService = { tpmWork: async (_host, id) => catalog.works.find(item => item.id === id) ?? work, tpmList: async () => catalog,
    tpmCreate: async (host, input) => { creates.push({ host, ...input }); return work; }, tpmAction: async () => work };
  let state!: ReturnType<typeof useTpmWork>;
  function Harness() {
    const trigger = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    state = useTpmWork(service, [{ id: 'host', name: 'Host', online: true }], true, async value => ({ ...value, agentId: 'tpm-agent' }));
    return <TpmMenu tpm={state} main={main} visible open={open} onOpenChange={setOpen} triggerRef={trigger} inert={false} />;
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

it.each(['completed', 'validating'] as const)('keeps archived %s sessions accessible without counting them as active or showing attention', async phase => {
  const h = harness({ supported: true, supportedProviders: ['codex'], works: [{ ...work, archived: true, phase, paused: true }] });
  const container = await render(<h.Harness />);
  expect(container.querySelector('.lab-tpm-count')!.textContent).toBe('0');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="TPM works"]')!.click());
  const archive = container.querySelector<HTMLDetailsElement>('.lab-tpm-archived')!;
  expect(archive.open).toBe(false);
  expect(archive.textContent).toContain('Archived (1)');
  expect(archive.querySelector('.lab-tpm-needs-user')).toBeNull();
  expect(container.querySelectorAll('.lab-tpm-panel > .lab-tpm-group').length).toBe(0);
  await act(async () => archive.querySelector('summary')!.click());
  await act(async () => archive.querySelector<HTMLButtonElement>('[data-tpm-work]')!.click());
  expect(h.state().expanded).toBe(true);
});

it('keeps navigation open while selecting and interacting with TPM workspaces', async () => {
  const h = harness({ supported: true, works: [work, { ...work, id: 'other', title: 'Other work', tpmNativeSessionId: 'other-tpm' }] });
  const container = await render(<h.Harness />);
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="TPM works"]')!;
  await act(async () => trigger.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[data-tpm-work]')].find(row => row.textContent?.includes('Search delivery'))!.click());
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('[data-tpm-work][aria-current="true"]')?.textContent).toContain('Search delivery');
  const workspace = document.createElement('section');
  workspace.className = 'lab-tpm-viewport';
  const input = workspace.appendChild(document.createElement('textarea'));
  document.body.append(workspace);
  try {
    await act(async () => input.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[data-tpm-work]')].find(row => row.textContent?.includes('Other work'))!.click());
    expect(h.state().sessions[h.state().selected!]!.nativeSessionId).toBe('other-tpm');
    expect(container.querySelector('[data-tpm-work][aria-current="true"]')?.textContent).toContain('Other work');
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  } finally { workspace.remove(); }
});
it('groups active and archived work under their main sessions', async () => {
  const h = harness({ supported: true, works: [work, { ...work, id: 'second', title: 'Second work' },
    { ...work, id: 'different', mainNativeSessionId: 'other-main', title: 'Other project' },
    { ...work, id: 'archived', archived: true, title: 'Archived work' }] });
  const container = await render(<h.Harness />);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="TPM works"]')!.click());
  const groups = container.querySelectorAll('.lab-tpm-panel > .lab-tpm-group');
  expect(groups.length).toBe(2);
  const mainGroup = [...groups].find(group => group.querySelector('h3')!.textContent === 'Main session')!;
  expect(mainGroup.querySelectorAll('[data-tpm-work]').length).toBe(2);
  expect([...groups].some(group => group.querySelector('h3')!.textContent === 'other-main')).toBe(true);
  expect(container.querySelector('.lab-tpm-archived h3')!.textContent).toBe('Main session');
});
