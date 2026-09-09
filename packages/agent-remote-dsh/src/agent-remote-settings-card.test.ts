import { describe, expect, it } from 'vitest';
import {
  reconcileRemoteHostSettingsDraft,
  remoteHostSettingsMutation,
} from './agent-remote-settings-card.js';

describe('Agent Remote Settings card mutation', () => {
  it('does not include an unchanged secret in a settings mutation', () => {
    expect(remoteHostSettingsMutation({
      resolved: { serverUrl: 'https://borgee.example', instanceName: 'Laptop' },
      draft: { serverUrl: 'https://borgee.example', instanceName: 'Laptop' },
    })).toEqual([]);
  });

  it('writes a typed secret with the visible fields in one mutation', () => {
    expect(remoteHostSettingsMutation({
      resolved: { serverUrl: 'https://old.example', instanceName: 'Laptop' },
      draft: { serverUrl: 'https://new.example', remoteKey: 'new-remote-key', instanceName: 'Desk' },
    })).toEqual([
      { op: 'set', path: ['serverUrl'], value: 'https://new.example' },
      { op: 'set', path: ['remoteKey'], value: 'new-remote-key' },
      { op: 'set', path: ['instanceName'], value: 'Desk' },
    ]);
  });

  it('persists a blank server URL to disable an environment-provided connection', () => {
    expect(remoteHostSettingsMutation({
      resolved: { serverUrl: 'https://environment.example', instanceName: 'Host device' },
      draft: { serverUrl: '', instanceName: 'Host device' },
    })).toEqual([{ op: 'set', path: ['serverUrl'], value: '' }]);
  });

  it('persists a blank instance-name override for the Host device-name fallback', () => {
    expect(remoteHostSettingsMutation({
      resolved: { serverUrl: 'https://borgee.example', instanceName: 'Environment device' },
      draft: { serverUrl: 'https://borgee.example', instanceName: '' },
    })).toEqual([{ op: 'set', path: ['instanceName'], value: '' }]);
  });

  it('keeps a dirty draft while a rejected or conflicting write refreshes the settings snapshot', () => {
    expect(reconcileRemoteHostSettingsDraft({
      initialized: true,
      draft: { serverUrl: 'https://edited.example', instanceName: 'Laptop' },
      previousResolved: { serverUrl: 'https://borgee.example', instanceName: 'Laptop' },
      resolved: { serverUrl: 'https://someone-else.example', instanceName: 'Laptop' },
    })).toEqual({ serverUrl: 'https://edited.example', instanceName: 'Laptop' });
  });

  it('adopts the initial and later clean snapshot values', () => {
    expect(reconcileRemoteHostSettingsDraft({
      initialized: false,
      draft: { serverUrl: '', instanceName: '' },
      previousResolved: { serverUrl: '', instanceName: '' },
      resolved: { serverUrl: 'https://borgee.example', instanceName: 'Laptop' },
    })).toEqual({ serverUrl: 'https://borgee.example', instanceName: 'Laptop' });
    expect(reconcileRemoteHostSettingsDraft({
      initialized: true,
      draft: { serverUrl: 'https://borgee.example', instanceName: 'Laptop' },
      previousResolved: { serverUrl: 'https://borgee.example', instanceName: 'Laptop' },
      resolved: { serverUrl: 'https://updated.example', instanceName: 'Desktop' },
    })).toEqual({ serverUrl: 'https://updated.example', instanceName: 'Desktop' });
  });
});
