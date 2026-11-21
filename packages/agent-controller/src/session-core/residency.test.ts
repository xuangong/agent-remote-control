import { UNDECLARED_PROVIDER_BEHAVIOUR } from '@orchardworks/agent-provider-sdk';
import { claudeBehaviour } from '@orchardworks/agent-provider-claude';
import { codexBehaviour } from '@orchardworks/agent-provider-codex';
import { describe, expect, it } from 'vitest';

import { decideResidency, releaseGraceMs } from './residency.js';
import { RELEASE_GRACE_VECTORS, RESIDENCY_VECTORS } from './residency-vectors.js';

describe('residency', () => {
  it.each(RESIDENCY_VECTORS.map(row => [row.name, row] as const))('%s', (_name, row) => {
    expect(decideResidency(row.facts)).toBe(row.decision);
  });
});

describe('the release grace', () => {
  it.each(RELEASE_GRACE_VECTORS.map(row => [row.name, row] as const))('%s', (_name, row) => {
    expect(releaseGraceMs(row.behaviour)).toBe(row.graceMs);
  });

  it('follows what each adapter declares: Codex through its daemon 10 s, Claude Code and an undeclared adapter five minutes (R4)', () => {
    expect(releaseGraceMs(codexBehaviour('shared'))).toBe(10_000);
    expect(releaseGraceMs(codexBehaviour('private'))).toBe(300_000);
    expect(releaseGraceMs(claudeBehaviour)).toBe(300_000);
    expect(releaseGraceMs(UNDECLARED_PROVIDER_BEHAVIOUR)).toBe(300_000);
  });

  it("lets Codex unload a session within 80 s of the last page closing: the grace and Codex's own 70 s (R4)", () => {
    const daemon = codexBehaviour('shared');
    expect(releaseGraceMs(daemon) + daemon.concurrency.unloadAfterLastClientMs!).toBe(80_000);
  });
});
