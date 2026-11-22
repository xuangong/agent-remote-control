// @vitest-environment node
import { expect, it } from 'vitest';
import { defaultPushSubject, pushFromEnvironment } from './push-config.js';

const PUBLIC = 'BJCvH34pg0ewCKH6gjeQ0zKQ5AVHcXEq9FAwfZ2q8QgvchIBo6aNBy69BP9Gu4ndH8GG7coRd_b2m8QvfdaK0T4';
const PRIVATE = 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94';
const ORIGIN = 'https://agents.example';

it('reads both halves of the key pair and signs as the Relay\'s origin unless a subject is set', () => {
  expect(pushFromEnvironment({ AGENT_REMOTE_PUSH_PUBLIC_KEY: PUBLIC, AGENT_REMOTE_PUSH_PRIVATE_KEY: ` ${PRIVATE}\n` }, ORIGIN))
    .toEqual({ configuration: { vapid: { publicKey: PUBLIC, privateKey: PRIVATE, subject: ORIGIN } } });
  expect(pushFromEnvironment({ AGENT_REMOTE_PUSH_PUBLIC_KEY: PUBLIC, AGENT_REMOTE_PUSH_PRIVATE_KEY: PRIVATE, AGENT_REMOTE_PUSH_SUBJECT: 'mailto:owner@example.com' }, ORIGIN)
    .configuration?.vapid.subject).toBe('mailto:owner@example.com');
  expect(defaultPushSubject('http://127.0.0.1:4910')).toBe('mailto:orchard@localhost');
});

it('is off without keys, and off with a reason for one half alone or a key of the wrong shape', () => {
  expect(pushFromEnvironment({}, ORIGIN)).toEqual({});
  expect(pushFromEnvironment({ AGENT_REMOTE_PUSH_PUBLIC_KEY: PUBLIC }, ORIGIN).problem).toContain('the secret AGENT_REMOTE_PUSH_PRIVATE_KEY is not');
  expect(pushFromEnvironment({ AGENT_REMOTE_PUSH_PRIVATE_KEY: PRIVATE }, ORIGIN).problem).toContain('AGENT_REMOTE_PUSH_PUBLIC_KEY is not');
  expect(pushFromEnvironment({ AGENT_REMOTE_PUSH_PUBLIC_KEY: PRIVATE, AGENT_REMOTE_PUSH_PRIVATE_KEY: PRIVATE }, ORIGIN).problem).toContain('uncompressed');
  expect(pushFromEnvironment({ AGENT_REMOTE_PUSH_PUBLIC_KEY: PUBLIC, AGENT_REMOTE_PUSH_PRIVATE_KEY: PUBLIC }, ORIGIN).problem).toContain('32-byte');
  expect(pushFromEnvironment({ AGENT_REMOTE_PUSH_PUBLIC_KEY: PUBLIC, AGENT_REMOTE_PUSH_PRIVATE_KEY: PRIVATE, AGENT_REMOTE_PUSH_SUBJECT: 'owner@example.com' }, ORIGIN).problem).toContain('mailto:');
});
