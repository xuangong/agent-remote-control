import { act } from 'react';
import { expect, it } from 'vitest';
import { SessionTodoPanel } from '@orchardworks/agent-remote-web/react';
import type { SessionTodoList } from '@orchardworks/agent-remote-protocol';
import { render } from '../test/setup.js';

const list: SessionTodoList = { revision: 4, planRevision: 1, changes: [], steps: [
  { id: 'plan', title: 'Discuss plan', acceptance: 'Proposal exists', kind: 'task', status: 'completed', evidence: ['Discussed'] },
  { id: 'agree', title: 'Agree scope', acceptance: 'User agrees', kind: 'confirmation', status: 'waiting', confirmation: { id: 'request-1', content: 'Build exact search without fuzzy matching.' } },
  { id: 'build', title: 'Implement', acceptance: 'Tests pass', kind: 'task', status: 'pending' },
] };
it('shows the exact proposal and sends the displayed revision and request only after an explicit click', async () => {
  const decisions: unknown[] = [];
  const element = await render(<SessionTodoPanel list={list} onConfirm={async value => { decisions.push(value); }} />);
  expect(element.textContent).toContain('1/3');
  expect(element.textContent).toContain('Build exact search without fuzzy matching.');
  expect(decisions).toEqual([]);
  await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Approve current todo step"]')!.click());
  expect(decisions).toEqual([{ revision: 4, stepId: 'agree', requestId: 'request-1', decision: 'approve' }]);
});
it('keeps confirmation errors visible and provides a request-changes action', async () => {
  const decisions: unknown[] = [];
  const element = await render(<SessionTodoPanel list={list} onConfirm={async value => { decisions.push(value); throw new Error('The list changed. Refresh.'); }} />);
  await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Request todo changes"]')!.click());
  expect(decisions).toEqual([{ revision: 4, stepId: 'agree', requestId: 'request-1', decision: 'revise' }]);
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('The list changed');
});
it('does not offer mutation on a read-only view', async () => {
  const element = await render(<SessionTodoPanel list={list} disabled onConfirm={async () => { throw new Error('Unexpected mutation'); }} />);
  expect(element.querySelector<HTMLButtonElement>('[aria-label="Approve current todo step"]')!.disabled).toBe(true);
});
