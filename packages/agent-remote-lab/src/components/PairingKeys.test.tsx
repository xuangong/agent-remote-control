import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { HostPairing, type PairingPurpose, type HostPairingService } from './HostPairing.js';

const invitation = { id: 'new', key: 'private-secret', purpose: 'host-only' as const, createdAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', serverUrl: 'https://relay.example' };
const record = (id: string, status: 'unused' | 'used' | 'obsolete' | 'revoked') => ({ id, purpose: 'host-only' as const, status, createdAt: invitation.createdAt, expiresAt: invitation.expiresAt, ...(status === 'used' ? { hostId: 'studio-id', hostName: 'Studio', usedAt: '2026-01-02T00:00:00Z' } : {}) });
async function open(service: HostPairingService) {
  const view = await render(<HostPairing service={service} selectedHostId="local" hosts={[]} onSelect={() => undefined} onRetryHosts={() => undefined} />);
  await act(async () => button(view, 'Pair Agent Host').click());
  return view;
}
function button(view: HTMLElement, label: string) { return [...view.querySelectorAll('button')].find(item => item.textContent === label)!; }

it('defaults to Host only and requires choosing Gateway token + CLI setup explicitly', async () => {
  const pair = vi.fn(async (purpose: PairingPurpose = 'host-only') => ({ ...invitation, purpose }));
  const view = await open({ hosts: async () => ({ hosts: [] }), pair, pairings: async () => ({ pairings: [record('new', 'unused')], availablePurposes: ['host-only', 'gateway-setup'] }) });
  const select = view.querySelector<HTMLSelectElement>('#pairing-purpose')!;
  expect(select?.value).toBe('host-only');
  await act(async () => button(view, 'Generate pairing key').click());
  expect(pair).toHaveBeenLastCalledWith('host-only');
  await act(async () => { select.value = 'gateway-setup'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => button(view, 'Generate new key').click());
  expect(pair).toHaveBeenLastCalledWith('gateway-setup');
  expect(view.textContent).toContain('Gateway token + CLI setup');
  expect(view.querySelector<HTMLTextAreaElement>('textarea')?.value).toContain('private-secret');
});

it('does not offer Gateway setup when the server supports only Host pairing', async () => {
  const view = await open({ hosts: async () => ({ hosts: [] }), pair: async () => invitation, pairings: async () => ({ pairings: [], availablePurposes: ['host-only'] }) });
  expect(view.querySelector('option[value="gateway-setup"]')).toBeNull();
  expect(view.textContent).toContain('No pairing keys yet');
});

it('shows secret-free history, limits revoke to unused keys and explains deletion effects', async () => {
  let pairings = ['unused', 'used', 'obsolete', 'revoked'].map(status => record(status, status as 'unused' | 'used' | 'obsolete' | 'revoked'));
  const revokePairing = vi.fn(async (id: string) => { pairings = pairings.map(item => item.id === id ? { ...item, status: 'revoked' as const } : item); });
  const deletePairing = vi.fn(async (id: string) => { pairings = pairings.filter(item => item.id !== id); });
  const view = await open({ hosts: async () => ({ hosts: [] }), pair: async () => invitation, pairings: async () => ({ pairings, availablePurposes: ['host-only'] }), revokePairing, deletePairing });
  const history = view.querySelector<HTMLElement>('[aria-label="Pairing key history"]')!;
  expect(history?.textContent).toContain('Unused');
  expect(history.textContent).toContain('Used');
  expect(history.textContent).toContain('Obsolete');
  expect(history.textContent).toContain('Revoked');
  expect(history.textContent).toContain('Studio');
  expect(history.textContent).not.toContain('private-secret');
  expect([...history.querySelectorAll('button')].filter(item => item.textContent === 'Revoke key')).toHaveLength(1);
  const unused = history.querySelector<HTMLElement>('[data-pairing-id="unused"]')!;
  await act(async () => button(unused, 'Delete history').click());
  expect(view.textContent).toContain('invalidates this unused key');
  await act(async () => button(view, 'Cancel deletion').click());
  const used = history.querySelector<HTMLElement>('[data-pairing-id="used"]')!;
  await act(async () => button(used, 'Delete history').click());
  expect(view.textContent).toContain('does not revoke Host credentials or Gateway tokens');
  expect(deletePairing).not.toHaveBeenCalled();
  await act(async () => button(view, 'Confirm deletion').click());
  expect(history.querySelector('[data-pairing-id="used"]')).toBeNull();
  await act(async () => button(unused, 'Revoke key').click());
  await act(async () => button(view, 'Confirm key revocation').click());
  expect(history.querySelector('[data-pairing-id="unused"]')?.textContent).toContain('Revoked');
});

it('clears the displayed secret after revoking its invitation', async () => {
  let status = 'unused' as 'unused' | 'revoked';
  const view = await open({ invitation, hosts: async () => ({ hosts: [] }), pair: async () => invitation, pairings: async () => ({ pairings: [record('new', status)], availablePurposes: ['host-only'] }), revokePairing: async () => { status = 'revoked'; } });
  // The cached invitation opens the panel immediately, so open() toggled it closed.
  await act(async () => button(view, 'Pair Agent Host').click());
  await act(async () => button(view, 'Revoke key').click());
  await act(async () => button(view, 'Confirm key revocation').click());
  expect(view.querySelector('textarea')).toBeNull();
});

it('requires fresh login without replaying deletion or trusting a server redirect', async () => {
  const deletePairing = vi.fn(async () => { throw Object.assign(new Error('Sign in'), { code: 'reauthentication_required', loginUrl: 'https://evil.example' }); });
  const view = await open({ hosts: async () => ({ hosts: [] }), pair: async () => invitation, pairings: async () => ({ pairings: [record('used', 'used')], availablePurposes: ['host-only'] }), deletePairing });
  await act(async () => button(view, 'Delete history').click());
  await act(async () => button(view, 'Confirm deletion').click());
  expect(view.textContent).toContain('Try the action again after signing in');
  expect(view.querySelector('a')?.getAttribute('href')).toMatch(/^\/auth\/login\?reauthenticate=1/);
  expect(deletePairing).toHaveBeenCalledOnce();
  expect(button(view, 'Confirm deletion')).toBeUndefined();
});

it('treats an expired unused key as obsolete and offers no revocation', async () => {
  const expired = { ...record('expired', 'unused'), expiresAt: '2020-01-01T00:00:00Z' };
  const view = await open({ hosts: async () => ({ hosts: [] }), pair: async () => invitation, pairings: async () => ({ pairings: [expired] }), revokePairing: async () => undefined });
  expect(view.textContent).toContain('Obsolete');
  expect(button(view, 'Revoke key')).toBeUndefined();
});

it('clears a consumed invitation when history is refreshed', async () => {
  let status = 'unused' as 'unused' | 'used';
  const service: HostPairingService = { invitation, hosts: async () => ({ hosts: [] }), pair: async () => invitation, pairings: async () => ({ pairings: [record('new', status)] }) };
  const view = await render(<HostPairing service={service} selectedHostId="local" hosts={[]} onSelect={() => undefined} onRetryHosts={() => undefined} />);
  expect(view.querySelector<HTMLTextAreaElement>('textarea')?.value).toContain('private-secret');
  status = 'used';
  await act(async () => button(view, 'Refresh keys').click());
  expect(view.querySelector('textarea')).toBeNull();
  expect(service.invitation).toBeUndefined();
  expect(view.textContent).toContain('Studio');
});

it('shows a history loading error and recovers through explicit refresh', async () => {
  let fail = true;
  const view = await open({ hosts: async () => ({ hosts: [] }), pair: async () => invitation, pairings: async () => {
    if (fail) throw new Error('History unavailable');
    return { pairings: [record('used', 'used')], availablePurposes: ['host-only', 'gateway-setup'] };
  } });
  expect(view.querySelector('[role="alert"]')?.textContent).toBe('History unavailable');
  expect(view.querySelector('option[value="gateway-setup"]')).toBeNull();
  fail = false;
  await act(async () => button(view, 'Refresh keys').click());
  expect(view.querySelector('[role="alert"]')).toBeNull();
  expect(view.textContent).toContain('Studio');
  expect(view.querySelector('option[value="gateway-setup"]')).not.toBeNull();
});

it('does not request history or show invitation management when management is hidden', async () => {
  const pairings = vi.fn(async () => ({ pairings: [record('used', 'used')] }));
  const view = await render(<HostPairing managementVisible={false} service={{ invitation, hosts: async () => ({ hosts: [] }), pair: async () => invitation, pairings }} selectedHostId="local" hosts={[]} onSelect={() => undefined} onRetryHosts={() => undefined} />);
  expect(view.querySelector('[aria-label="Pairing key history"]')).toBeNull();
  expect(pairings).not.toHaveBeenCalled();
});

it('waits for the current history request before allowing creation', async () => {
  let resolveHistory!: (value: { pairings: []; availablePurposes: ['host-only'] }) => void;
  const response = new Promise<{ pairings: []; availablePurposes: ['host-only'] }>(resolve => { resolveHistory = resolve; });
  const view = await open({ hosts: async () => ({ hosts: [] }), pair: async () => invitation, pairings: () => response });
  expect(button(view, 'Generate pairing key').disabled).toBe(true);
  await act(async () => resolveHistory({ pairings: [], availablePurposes: ['host-only'] }));
  expect(button(view, 'Generate pairing key').disabled).toBe(false);
});
