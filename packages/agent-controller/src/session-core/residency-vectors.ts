import type { AgentProviderBehaviour } from '@orchardworks/agent-provider-sdk';

import type { ResidencyDecision, ResidencyFacts } from './residency.js';

/** The residency rule as rows: facts and the decision they give (`residency.ts`, R1 to R3). */
export const RESIDENCY_VECTORS: ReadonlyArray<{ name: string; facts: ResidencyFacts; decision: ResidencyDecision }> = [
  { name: 'R1: a shown session is kept long after its grace', facts: { shown: true, held: false, releasable: true, unkeptMs: 3_600_000, graceMs: 10_000 }, decision: 'keep' },
  { name: 'R1: a shown session is kept while it cannot be released either', facts: { shown: true, held: true, releasable: false, unkeptMs: 0, graceMs: 10_000 }, decision: 'keep' },
  { name: 'R2: a held session no page shows is kept', facts: { shown: false, held: true, releasable: true, unkeptMs: 3_600_000, graceMs: 10_000 }, decision: 'keep' },
  { name: 'R2: a session that cannot be released now is kept', facts: { shown: false, held: false, releasable: false, unkeptMs: 3_600_000, graceMs: 10_000 }, decision: 'keep' },
  { name: 'R3: an unkept session waits inside its grace', facts: { shown: false, held: false, releasable: true, unkeptMs: 0, graceMs: 10_000 }, decision: 'wait' },
  { name: 'R3: an unkept session waits a millisecond before its grace ends', facts: { shown: false, held: false, releasable: true, unkeptMs: 9_999, graceMs: 10_000 }, decision: 'wait' },
  { name: 'R3: an unkept session is released at its grace', facts: { shown: false, held: false, releasable: true, unkeptMs: 10_000, graceMs: 10_000 }, decision: 'release' },
  { name: 'R3: an unkept session is released after its grace', facts: { shown: false, held: false, releasable: true, unkeptMs: 10_001, graceMs: 10_000 }, decision: 'release' },
];

const concurrency = (unloadAfterLastClientMs?: number): AgentProviderBehaviour['concurrency'] => ({ model: 'shared_clients', probe: 'none', othersVisible: 'live', ...(unloadAfterLastClientMs === undefined ? {} : { unloadAfterLastClientMs }) });

/** The release grace each declared behaviour gives (`residency.ts`, R4). */
export const RELEASE_GRACE_VECTORS: ReadonlyArray<{ name: string; behaviour: Pick<AgentProviderBehaviour, 'concurrency' | 'resume'>; graceMs: number }> = [
  { name: 'a CLI that keeps a session loaded 70 s after its last client (Codex): the page-return grace', behaviour: { concurrency: concurrency(70_000), resume: { cost: 'subscription', deadlineMs: 90_000 } }, graceMs: 10_000 },
  { name: 'a CLI that keeps a session loaded, whatever its resume costs: the page-return grace', behaviour: { concurrency: concurrency(1), resume: { cost: 'process', deadlineMs: 15_000 } }, graceMs: 10_000 },
  { name: 'a subscription to a running server (OpenCode)', behaviour: { concurrency: concurrency(), resume: { cost: 'subscription', deadlineMs: 15_000 } }, graceMs: 15_000 },
  { name: 'a call into a shared process (Copilot)', behaviour: { concurrency: concurrency(), resume: { cost: 'shared_process', deadlineMs: 15_000 } }, graceMs: 60_000 },
  { name: 'a process of its own (Claude Code, and an adapter that declares nothing): five minutes', behaviour: { concurrency: concurrency(), resume: { cost: 'process', deadlineMs: 15_000 } }, graceMs: 300_000 },
];
