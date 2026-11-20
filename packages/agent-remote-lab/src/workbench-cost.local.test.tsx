// Stage 6's workbench measurement (see performance/README.md): not part of the suite, run on purpose with
// `pnpm exec vitest run src/workbench-cost.local.test.tsx`. It prints jsdom timings for frames of the shared states
// channel and bot switches with 12 groups of 10 bots, and how many conversations each renders.
import { act } from 'react';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createWindowView, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import * as conversation from './components/SessionConversation.js';
import { botTarget, mountBotApp, seedGroup, until } from './test/bot-mode-fixtures.js';

const output = resolve(process.env.ARC_PERFORMANCE_OUTPUT ?? '.tmp/workbench-cost.log');
const log = (line: string) => appendFileSync(output, line + '\n');
function largeGroup(index: number): WindowGroup {
  const id = `G${index}`;
  const views = Array.from({ length: 10 }, (_, bot) => createWindowView(`${id}v${bot}`, botTarget(`${id}s${bot}`), 'primary'));
  return { window: { schemaVersion: 3, id, revision: 0, title: id, selectedPrimaryViewId: views[0]!.id, selectedViewId: views[0]!.id, views }, bots: { rank: `r${String(index).padStart(3, '0')}`, members: {} } };
}
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it('measures shared states frames and bot switches in a large workbench', { timeout: 120_000 }, async () => {
  const scope = 'http://localhost/u/workbench-cost/';
  for (let index = 0; index < 12; index++) seedGroup(scope, largeGroup(index));
  history.replaceState(null, '', '/?window=G0');
  const renders = vi.spyOn(conversation, 'SessionConversation');
  const app = await mountBotApp(scope, { hosted: true });
  await app.switchMode('bot');
  await until(() => expect(app.container.querySelectorAll('nav[aria-label="Assistants"] .lab-bot-row').length).toBeGreaterThanOrEqual(120));
  await act(async () => app.button('G0s0').click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
  const session = (id: string) => ({ hostId: 'local', providerId: 'recorded', nativeSessionId: id });
  const frames: string[] = [];
  for (let i = 0; i < 6; i++) {
    renders.mockClear();
    const started = performance.now();
    await act(async () => app.emitStates({ hosts: [{ hostId: 'local', online: true }], states: [{ ...session(`G5s${i}`), state: i % 2 ? 'idle' : 'running', ageMs: 0, replyAt: 1000 + i, preview: `Reply ${i}` }] }));
    frames.push(`${(performance.now() - started).toFixed(1)} ms/${renders.mock.calls.length}`);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  }
  log(`states frames (time/conversation renders): ${frames.join(', ')}`);
  for (const bot of ['G3s2', 'G4s5', 'G3s2', 'G6s1', 'G4s5', 'G7s3', 'G3s2']) {
    renders.mockClear();
    const started = performance.now();
    await act(async () => app.button(bot).click());
    await vi.waitFor(async () => { await act(async () => {}); expect(app.container.querySelector('.lab-bot-row[aria-current="true"]')?.getAttribute('aria-label')).toBe(bot); }, { timeout: 20_000, interval: 5 });
    log(`switch to ${bot}: ${(performance.now() - started).toFixed(1)} ms until current, conversation renders ${renders.mock.calls.length}`);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  }
  await app.close();
});
