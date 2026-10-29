import { expect, it } from 'vitest';
import type { AgentProviderDescriptor } from '@orchardworks/agent-provider-sdk';
import { roleSessionConfig } from './role-session-creation.js';

const plain: AgentProviderDescriptor = { providerId: 'plain', displayName: 'Plain', sessionExtensions: { instructions: true, tools: true } };
const readOnly: AgentProviderDescriptor = { ...plain, providerId: 'guarded', displayName: 'Guarded', sessionAccess: { readOnly: true } };

it('creates a role session with its selections and the role extensions', () => {
  expect(roleSessionConfig(readOnly, { cwd: '/w', model: 'm', reasoningEffort: 'high' }, { instructions: 'Review.', access: 'read_only' }))
    .toEqual({ cwd: '/w', model: 'm', reasoningEffort: 'high', instructions: 'Review.', access: 'read_only' });
  expect(roleSessionConfig(plain, { cwd: undefined }, { instructions: 'Lead.' })).toEqual({ instructions: 'Lead.' });
});

it('refuses read-only access on a provider that does not enforce it', () => {
  expect(() => roleSessionConfig(plain, { cwd: '/w' }, { access: 'read_only' })).toThrow(/Plain cannot run read-only sessions/);
});
