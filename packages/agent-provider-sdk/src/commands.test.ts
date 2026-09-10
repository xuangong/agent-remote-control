import { describe, expect, it } from 'vitest';
import { CommandInteractions, validateCommandDirectory } from './commands.js';
import type { AgentStreamEvent } from './observation.js';

describe('command interactions', () => {
  it('keeps a failed step retryable and allows native continuation to open another step', async () => {
    const events: AgentStreamEvent[] = [];
    const flow = new CommandInteractions('native', (event) => events.push(event));
    const request = { kind: 'form' as const, title: 'Choose', message: '', fields: [{ fieldId: 'value', label: 'Value', type: 'select' as const, required: true, options: [{ value: 'a', label: 'A' }] }] };
    let refused = true;
    const id = flow.open(request, async () => {
      if (refused) throw new Error('Native refused');
      flow.open(request, async () => {});
    });
    await expect(flow.respond(id, { kind: 'form', action: 'submit', values: { value: 'bad' } })).rejects.toThrow();
    await expect(flow.respond(id, { kind: 'form', action: 'submit', values: { value: 'a' } })).rejects.toThrow('Native refused');
    expect(flow.pending).toBe(true);
    refused = false;
    await expect(flow.respond(id, { kind: 'form', action: 'submit', values: { value: 'a' } })).resolves.toBe(true);
    expect(flow.pending).toBe(true);
    await expect(flow.respond(id, { kind: 'form', action: 'cancel' })).resolves.toBe(false);
    expect(events.filter((event) => event.type === 'interaction_resolved')).toHaveLength(1);
    flow.clear();
    expect(flow.pending).toBe(false);
  });

  it('prevents duplicate responses while the native operation is pending', async () => {
    const flow = new CommandInteractions('native', () => {});
    let finish!: () => void;
    const id = flow.open({ kind: 'form', title: 'Confirm', message: '', fields: [] }, () => new Promise<void>((resolve) => { finish = resolve; }));
    const response = { kind: 'form' as const, action: 'submit' as const, values: {} };
    const first = flow.respond(id, response);
    await expect(flow.respond(id, response)).rejects.toThrow('pending');
    finish();
    await first;
    expect(flow.pending).toBe(false);
  });

  it('rejects duplicate command identities and malformed names', () => {
    const command = { id: 'one', name: 'native-command', description: 'Native', kind: 'command' as const };
    expect(validateCommandDirectory([command])).toEqual([command]);
    expect(() => validateCommandDirectory([command, command])).toThrow();
    expect(() => validateCommandDirectory([{ ...command, name: '/invalid' }])).toThrow();
  });
});
