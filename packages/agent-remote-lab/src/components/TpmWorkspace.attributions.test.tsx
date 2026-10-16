import { act, useRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { render } from '../test/setup.js';
import { DraftStore } from '../draft-store.js';
import type { TpmItem } from '../hooks/useTpmWork.js';
import { SessionDescriptionsContext } from '../session-description-context.js';
import { describeSession } from '../session-description.js';
import type { SessionEntry } from '../session-tree.js';
import { TpmWorkspace } from './TpmWorkspace.js';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });

const item: TpmItem = { key: 'work', hostId: 'host', hostName: 'Mac mini', online: false, unread: false,
  work: { id: 'work', revision: 1, title: 'Search', providerId: 'codex', tpmNativeSessionId: 'tpm', mainNativeSessionId: 'main',
    phase: 'implementing', waiting: 'main_session', paused: false, summary: '', nextAction: '', document: '', acceptance: '', evidence: [],
    createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z', nextCheckAt: 100 } };

function Workspace({ current = item, onOpenMain = () => {} }: { current?: TpmItem; onOpenMain?(): void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return <TpmWorkspace item={current} mainTitle="Project A" visible storageScope="tpm-attributions" triggerRef={trigger}
    transport={{} as RemoteAgentTransport} draftBinding={{ store: new DraftStore('tpm-attributions'), key: current.key }}
    onClose={() => {}} onShowList={() => {}} onOpenMain={onOpenMain} onAction={async () => {}} onResolve={async () => {}} onRetry={() => {}} />;
}

it('shows the shared property table from the TPM heading even while its native session is offline', async () => {
  const openMain = vi.fn();
  const container = await render(<Workspace onOpenMain={openMain} />);
  const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Show session attributions"]')!;
  expect(toggle.closest('.lab-tpm-heading')).not.toBeNull();
  expect(container.querySelectorAll('[aria-label="Show session attributions"]')).toHaveLength(1);
  expect(container.querySelector('table')).toBeNull();
  expect(container.querySelector('.lab-tpm-work-status')?.textContent).not.toContain('Project A');
  const draft = container.querySelector('[aria-label="TPM draft"]');
  await act(async () => toggle.click());
  const table = container.querySelector('table[aria-label="Session attributions"]')!;
  expect(table.textContent).toContain('RoleTPM');
  expect(table.textContent).toContain('Project A');
  expect(table.closest('.lab-tpm-conversation')).toBeNull();
  expect(container.querySelector('[aria-label="TPM draft"]')).toBe(draft);
  await act(async () => table.querySelector<HTMLButtonElement>('td button')!.click());
  expect(openMain).toHaveBeenCalledOnce();
}, 5000);

it('uses container descriptions and navigation instead of the Main-only callback', async () => {
  const openMain = vi.fn(), navigate = vi.fn(async () => {});
  const describe = vi.fn((session: SessionEntry) => describeSession({ session, tpmWorks: [item], sessions: [
    { hostId: 'host', providerId: 'codex', nativeSessionId: 'main', title: 'Current project title' },
  ] }));
  const container = await render(<SessionDescriptionsContext.Provider value={{ describe, navigate }}><Workspace onOpenMain={openMain} /></SessionDescriptionsContext.Provider>);
  expect(describe).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'host', providerId: 'codex', nativeSessionId: 'tpm' }));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show session attributions"]')!.click());
  const button = container.querySelector<HTMLButtonElement>('td button')!;
  expect(button.textContent).toContain('Current project title');
  await act(async () => button.click());
  expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'main', target: expect.objectContaining({ nativeSessionId: 'main' }) }));
  expect(openMain).not.toHaveBeenCalled();
}, 5000);

it('keeps role-origin details readable without offering unsupported fallback navigation', async () => {
  const current: TpmItem = { ...item, work: { ...item.work,
    mainBinding: { kind: 'primary_role', roleId: 'main-role', origin: { controllerId: 'installation', providerId: 'codex', nativeSessionId: 'original' } },
    mainSessionRef: { controllerId: 'installation', providerId: 'codex', nativeSessionId: 'main' },
  } };
  const container = await render(<Workspace current={current} />);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show session attributions"]')!.click());
  const original = [...container.querySelectorAll('tr')].find(row => row.querySelector('th')?.textContent === 'Role origin')!;
  expect(original.textContent).toContain('original');
  expect(original.querySelector('button')).toBeNull();
  expect(container.querySelectorAll('td button')).toHaveLength(1);
}, 5000);

it('does not invent a session identity for work whose creation is still unresolved', async () => {
  const openMain = vi.fn();
  const container = await render(<Workspace onOpenMain={openMain} current={{ ...item, work: { ...item.work, tpmNativeSessionId: undefined, creationStatus: 'unknown' } }} />);
  expect(container.querySelector('[aria-label="Show session attributions"]')).toBeNull();
  expect(container.querySelector('[aria-label="Confirm TPM creation"]')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open main session: Project A"]')!.click());
  expect(openMain).toHaveBeenCalledOnce();
}, 5000);
