// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { assertNativeDshVersions } from './installed-dsh-plugin.js';

describe('installed DSH host compatibility', () => {
  it('accepts the complete compatible native host peer set', () => {
    const version = vi.fn(() => '0.1.0-rc.6');
    expect(() => assertNativeDshVersions('0.1.0-rc.6', version)).not.toThrow();
    expect(version.mock.calls).toEqual([
      ['@deepseek-ai/dsh-agent'], ['@deepseek-ai/dsh-llm'], ['@deepseek-ai/dsh-session'],
    ]);
  });

  it.each(['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session'])(
    'rejects a mismatched %s even when the other peers are compatible',
    (incompatible) => {
      expect(() => assertNativeDshVersions('0.1.0-rc.6', (name) => name === incompatible ? '0.1.1' : '0.1.0-rc.6'))
        .toThrow(`requires ${incompatible} 0.1.0-rc.6; got 0.1.1`);
    },
  );
});
