import { describe, expect, it } from 'vitest';
import { hookUrlOf } from './hook-url.js';

describe('the public address of a webhook', () => {
  it('is the Relay origin, /hooks/, the account and the token, and none where the page is not on an account address', () => {
    expect(hookUrlOf('/u/abc123/', 'id.secret', 'https://relay.example')).toBe('https://relay.example/hooks/abc123/id.secret');
    expect(hookUrlOf('https://relay.example/u/abc123', 'id.secret')).toBe('https://relay.example/hooks/abc123/id.secret');
    expect(hookUrlOf('/', 'id.secret', 'https://relay.example')).toBeUndefined();
    expect(hookUrlOf('/other/', 'id.secret', 'https://relay.example')).toBeUndefined();
  });
});
