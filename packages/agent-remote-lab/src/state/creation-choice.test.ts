// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AgentProviderDescriptor } from '@orchardworks/agent-remote-protocol';
import type { RemoteHost } from '../kernel/remote-host.js';
import {
  availableProvidersOf, chosenProviderId, creationUnavailableReason, hostProviders, providerAfterHostChange, providerChoices,
  providerConnectionName, restoreHostSelection, type CreationFacts,
} from './creation-choice.js';

const codex: AgentProviderDescriptor = { providerId: 'codex', displayName: 'Codex' };
const claude: AgentProviderDescriptor = { providerId: 'claude', displayName: 'Claude Code' };
const host = (overrides: Partial<RemoteHost> = {}): RemoteHost => ({ id: 'h1', name: 'Laptop', online: true, providers: [codex, claude], ...overrides });

describe('the providers a Host advertises', () => {
  it('lists the providers of its record, else its single provider id, else the harness', () => {
    expect(hostProviders(host())).toEqual([codex, claude]);
    expect(hostProviders(host({ providers: undefined, providerId: 'claude' }))).toEqual([{ providerId: 'claude', displayName: 'claude' }]);
    expect(hostProviders(host({ providers: undefined }))).toEqual([{ providerId: 'dsh', displayName: 'DeepSeek Harness' }]);
    expect(hostProviders(undefined)).toEqual([]);
  });

  it('uses the Lab server catalog for the local Host only', () => {
    expect(availableProvidersOf('local', [claude], host())).toEqual([claude]);
    expect(availableProvidersOf('h1', [claude], host())).toEqual([codex, claude]);
    expect(availableProvidersOf('h1', [claude], undefined)).toEqual([]);
  });
});

describe('the provider choice', () => {
  it('keeps a preference the Host advertises and falls back to the first provider, or none', () => {
    expect(chosenProviderId([codex, claude], 'claude')).toBe('claude');
    expect(chosenProviderId([codex, claude], 'gone')).toBe('codex');
    expect(chosenProviderId([], 'codex')).toBe('');
  });

  it('names a choice by provider for the local Host and by Host and provider for a remote one', () => {
    expect(providerChoices('local', [codex])[0]).toMatchObject({ hostId: 'local', selectionId: 'codex', providerId: 'codex' });
    expect(providerChoices('h1', [codex])[0]!.selectionId).toBe(JSON.stringify(['h1', 'codex']));
  });

  it('moves to the preferred provider of a newly selected Host when it has it', () => {
    expect(providerAfterHostChange(host(), [], 'claude')).toBe('claude');
    expect(providerAfterHostChange(host({ providers: [codex] }), [], 'claude')).toBe('codex');
    expect(providerAfterHostChange({ id: 'local', name: 'Lab', online: true }, [claude], 'claude')).toBe('claude');
  });

  it('names a provider with its Host unless the Host is local', () => {
    expect(providerConnectionName('local', 'claude', [claude], [])).toBe('Claude Code');
    expect(providerConnectionName('h1', 'claude', [], [host()])).toBe('Claude Code · Laptop');
    expect(providerConnectionName('h1', 'unknown', [], [host()])).toBe('unknown');
    expect(providerConnectionName('missing', 'claude', [], [host()])).toBe('claude');
  });
});

describe('why creating a session is unavailable', () => {
  const ready: CreationFacts = { selectedHostId: 'h1', requestedHostId: undefined, hosts: [host()], hostsLoaded: true, hostError: false, hostSelectionRestored: true, providerId: 'codex', reserved: false };

  it('is available when the Host is online, within its quota and has a provider', () => {
    expect(creationUnavailableReason(ready)).toBeUndefined();
    expect(creationUnavailableReason({ ...ready, selectedHostId: 'local', hosts: [], providerId: '' })).toBeUndefined();
  });

  it.each([
    ['a requested Host that is not listed', { requestedHostId: 'gone', hostSelectionRestored: false }, /Requested Host is unavailable/],
    ['Hosts that are still loading', { hostsLoaded: false }, /Loading Hosts/],
    ['an offline Host', { hosts: [host({ online: false })] }, /offline/],
    ['an unlisted selected Host', { hosts: [] }, /offline/],
    ['an exhausted quota', { hosts: [host({ sessionQuota: { limit: 2, used: 2 } })] }, /creation limit/],
    ['a Host without providers', { providerId: '' }, /No providers/],
  ] as const)('says so for %s', (_name, change, reason) => {
    expect(creationUnavailableReason({ ...ready, ...change })).toMatch(reason);
  });

  it('does not block a creation that already holds its quota slot', () => {
    expect(creationUnavailableReason({ ...ready, hosts: [host({ sessionQuota: { limit: 2, used: 2 } })], reserved: true })).toBeUndefined();
  });

  it('stops saying Loading once the Host list failed, and puts a requested Host ahead of everything', () => {
    expect(creationUnavailableReason({ ...ready, hostsLoaded: false, hostError: true })).toBeUndefined();
    expect(creationUnavailableReason({ ...ready, hosts: [], hostsLoaded: false, hostError: true })).toMatch(/offline/);
    expect(creationUnavailableReason({ ...ready, requestedHostId: 'gone', hostSelectionRestored: false, hosts: [host({ online: false })] })).toMatch(/Requested Host/);
  });

  it('does not report a requested local Host or one that was restored', () => {
    expect(creationUnavailableReason({ ...ready, selectedHostId: 'local', requestedHostId: 'local', hostSelectionRestored: false, hosts: [] })).toBeUndefined();
    expect(creationUnavailableReason({ ...ready, requestedHostId: 'gone', hostSelectionRestored: true })).toBeUndefined();
  });
});

describe('restoring the Host selection', () => {
  it('waits for the Host list, and for the wanted Host to appear in it', () => {
    expect(restoreHostSelection({ requested: { hostId: 'h1', providerId: undefined }, hosts: [], remembered: undefined })).toEqual({ type: 'wait' });
    expect(restoreHostSelection({ requested: { hostId: 'gone', providerId: undefined }, hosts: [host()], remembered: undefined })).toEqual({ type: 'wait' });
    expect(restoreHostSelection({ requested: { hostId: undefined, providerId: undefined }, hosts: [host()], remembered: { hostId: 'gone', providerId: 'codex' } })).toEqual({ type: 'wait' });
  });

  it('selects the requested Host with the requested provider, or its first', () => {
    expect(restoreHostSelection({ requested: { hostId: 'h1', providerId: 'claude' }, hosts: [host()], remembered: undefined }))
      .toMatchObject({ type: 'select', providerId: 'claude', providerName: 'Claude Code · Laptop' });
    expect(restoreHostSelection({ requested: { hostId: 'h1', providerId: undefined }, hosts: [host()], remembered: undefined }))
      .toMatchObject({ type: 'select', providerId: 'codex', providerName: 'Codex · Laptop' });
  });

  it('names a requested provider the Host does not list by its id, and falls back to the Host provider id', () => {
    expect(restoreHostSelection({ requested: { hostId: 'h1', providerId: 'other' }, hosts: [host()], remembered: undefined }))
      .toMatchObject({ providerId: 'other', providerName: 'Codex · Laptop' });
    expect(restoreHostSelection({ requested: { hostId: 'h1', providerId: undefined }, hosts: [host({ providers: undefined, providerId: undefined })], remembered: undefined }))
      .toMatchObject({ providerId: 'dsh', providerName: 'dsh' });
  });

  it('follows the remembered session when no Host was requested, and does nothing without one', () => {
    expect(restoreHostSelection({ requested: { hostId: undefined, providerId: undefined }, hosts: [host()], remembered: { hostId: 'h1', providerId: 'claude' } }))
      .toMatchObject({ type: 'select', providerId: 'claude', providerName: 'Claude Code · Laptop' });
    expect(restoreHostSelection({ requested: { hostId: undefined, providerId: undefined }, hosts: [host()], remembered: undefined })).toEqual({ type: 'none' });
  });
});
