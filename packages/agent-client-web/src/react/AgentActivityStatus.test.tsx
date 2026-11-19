// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { SESSION_PRESENTATION_VECTORS, T5_PATTERN } from '@orchardworks/agent-client/testing';
import { render } from '../test/setup.js';
import { AgentActivityStatus } from './AgentActivityStatus.js';

describe('the activity line says the business label of each row, and never a connection word', () => {
  it.each(SESSION_PRESENTATION_VECTORS.map(row => [row.name, row] as const))('%s', async (_name, row) => {
    const container = await render(<AgentActivityStatus state={row.facts.replica} sessionState={row.facts.session} host={row.facts.host}
      interruptDisabled interruptLabel="Interrupt" onInterrupt={() => {}} />);
    const label = container.querySelector<HTMLElement>('[data-testid="agent-activity-label"]')!;
    if (row.label === undefined) expect(label.hidden).toBe(true);
    else expect(label.textContent).toBe(row.label);
    expect(container.textContent).not.toMatch(T5_PATTERN);
    const offline = container.querySelector('.agent-presence')!.classList.contains('agent-state-offline');
    expect(offline).toBe(row.notice !== undefined);
  });
});
