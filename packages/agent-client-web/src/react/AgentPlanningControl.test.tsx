// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { buildSnapshot, buildSessionFacts, CONTROL } from '@orchardworks/agent-client/testing';
import { render } from '../test/setup.js';
import { AgentPlanningControl } from './AgentPlanningControl.js';

function control(options: { active: boolean; status?: 'idle' | 'running' }, onSetPlanning?: (active: boolean) => Promise<void>) {
  const base = buildSnapshot();
  const facts = buildSessionFacts('ready', { control: CONTROL.granted, snapshot: {
    status: options.status ?? 'idle', activeTurn: options.status === 'running' ? { turnId: 't1', startedAt: '2026-11-15T00:00:00.000Z' } : null,
    capabilities: { ...base.capabilities, planning: true },
    runtimeInfo: { ...base.runtimeInfo, status: options.status ?? 'idle', planning: { active: options.active } },
  } });
  return <AgentPlanningControl state={facts.replica!} sessionState={facts.session} sessionStatus="ready" onSetPlanning={onSetPlanning} />;
}
const toggle = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('button[role="switch"]')!;

it.each([[false, true], [true, false]])('asks for planning %s -> %s when the switch is pressed on an idle session', async (active, requested) => {
  const set = vi.fn(async () => {});
  const container = await render(control({ active }, set));
  expect(toggle(container).getAttribute('aria-checked')).toBe(String(active));
  await act(async () => toggle(container).click());
  expect(set).toHaveBeenCalledExactlyOnceWith(requested);
});

it('keeps the switch off while the session works, and says planning changes only when idle', async () => {
  const set = vi.fn(async () => {});
  const container = await render(control({ active: false, status: 'running' }, set));
  expect(toggle(container).disabled).toBe(true);
  await act(async () => toggle(container).click());
  expect(set).not.toHaveBeenCalled();
  expect(container.querySelector('[role="status"]')?.textContent).toMatch(/idle/i);
});

it('shows why a change failed and lets the person try again', async () => {
  const set = vi.fn().mockRejectedValueOnce(new Error('Native refused')).mockResolvedValue(undefined);
  const container = await render(control({ active: false }, set));
  await act(async () => toggle(container).click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Native refused');
  expect(toggle(container).disabled).toBe(false);
  await act(async () => toggle(container).click());
  expect(set).toHaveBeenCalledTimes(2);
});
