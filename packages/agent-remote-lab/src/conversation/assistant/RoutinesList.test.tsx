import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Routine } from '@orchardworks/agent-remote-protocol';
import { render } from '../../test/setup.js';
import { RoutinesList, specOf, type RoutinesChoice, type RoutineSpec } from './RoutinesList.js';

const T = Date.parse('2026-11-30T10:00:00Z');
const routine = (extra: Partial<Routine> = {}): Routine => ({ id: 'r1', name: 'Morning check', schedule: { kind: 'weekdays', days: [1, 2, 3, 4, 5], time: '08:30' }, by: 'bot', anchor: 0, dueAt: T + 3_600_000, runCount: 2,
  runs: [{ n: 1, trigger: 'schedule', dueAt: T - 86_400_000, state: 'done', usd: 0.0421 }, { n: 2, trigger: 'schedule', dueAt: T - 3_600_000, state: 'skipped', reason: 'budget' }], ...extra });
function choice(routines: Routine[], extra: Partial<RoutinesChoice> = {}) {
  const saved: RoutineSpec[] = [], paused: Array<[string, boolean]> = [], removed: string[] = [], tested: string[] = [];
  const value: RoutinesChoice = { routines, zone: 'UTC', save: async spec => { saved.push(spec); return undefined; }, pause: async (name, flag) => { paused.push([name, flag]); }, remove: async name => { removed.push(name); }, test: async name => { tested.push(name); }, ...extra };
  return { value, saved, paused, removed, tested };
}
const click = (element: Element | null | undefined) => act(async () => { (element as HTMLElement).click(); });
const type = (input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => act(async () => {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
});
const button = (container: Element, label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label);

describe('a bot\'s routines in its details', () => {
  it('shows each routine with its schedule in words, who set it, its last run and what the runs cost, and says when there are none', async () => {
    const container = await render(<RoutinesList choice={choice([routine(), routine({ id: 'r2', name: 'work', work: true, by: 'system', schedule: { kind: 'quiet', minutes: 5 }, runs: [] })]).value} />);
    const rows = [...container.querySelectorAll('li[data-routine]')];
    expect(rows.map(row => row.getAttribute('data-routine'))).toEqual(['Morning check', 'work']);
    const text = rows[0]!.textContent!;
    expect(text).toContain('Weekdays at 08:30');
    expect(text).toContain('Set by the bot');
    expect(text).toContain('About ≈ $0.042 a run');
    expect(text).toContain('Run 2 ·');
    expect(text).toContain('skipped: over budget');
    // The automatic routine cannot be edited or deleted, only paused and tested.
    expect([...rows[1]!.querySelectorAll('button')].map(item => item.textContent)).toEqual(['Test', 'Pause', 'History']);
    const empty = await render(<RoutinesList choice={choice([]).value} />);
    expect(empty.textContent).toContain('No routines.');
  });
  it('tests, pauses, resumes and deletes a routine, and opens its history', async () => {
    const c = choice([routine(), routine({ id: 'r3', name: 'Held', paused: true })]);
    const container = await render(<RoutinesList choice={c.value} />);
    const [first, second] = [...container.querySelectorAll('li[data-routine]')] as [HTMLElement, HTMLElement];
    await click(button(first, 'Test')); await click(button(first, 'Pause')); await click(button(second, 'Resume')); await click(button(first, 'Delete'));
    expect(c.tested).toEqual(['Morning check']); expect(c.paused).toEqual([['Morning check', true], ['Held', false]]); expect(c.removed).toEqual(['Morning check']);
    await click(button(first, 'History'));
    expect([...first.querySelectorAll('ol li')].map(item => item.textContent)).toEqual([expect.stringContaining('Run 2'), expect.stringContaining('Run 1')]);
  });
  it('says why nothing starts when the account holds unattended work, and when an action did not go through', async () => {
    const held = await render(<RoutinesList choice={choice([routine()], { hold: 'budget' }).value} />);
    expect(held.querySelector('li[data-routine]')!.textContent).toContain('Over budget until the period ends');
    const failing = choice([routine()], { pause: async () => { throw new Error('No.'); } });
    const container = await render(<RoutinesList choice={failing.value} />);
    await click(button(container, 'Pause'));
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('That did not work. Try again.');
  });
  it('makes a new routine from the form: weekdays with chosen days and a time, a prompt and a model; and edits one without renaming it', async () => {
    const c = choice([routine()]);
    const container = await render(<RoutinesList choice={c.value} />);
    await click(button(container, 'New routine'));
    const form = container.querySelector('form')!;
    const field = (label: string) => [...form.querySelectorAll('label')].find(item => item.textContent!.startsWith(label))!.querySelector('input, select, textarea') as HTMLInputElement;
    expect(button(form, 'Save')!.disabled).toBe(true);
    await type(field('Name'), 'Standup'); await type(field('When') as unknown as HTMLSelectElement, 'weekdays');
    await type(field('Time'), '09:15'); await click(button(form, 'Sat')); await click(button(form, 'Fri'));
    await type(field('What to do'), 'Summarise yesterday.'); await type(field('Model'), 'claude-haiku-4-5'); await type(field('Runs a day'), '2');
    await click(button(form, 'Save'));
    expect(c.saved).toEqual([{ name: 'Standup', schedule: { kind: 'weekdays', days: [1, 2, 3, 4, 6], time: '09:15' }, prompt: 'Summarise yesterday.', model: 'claude-haiku-4-5', maxRunsPerDay: 2 }]);
    const edit = await render(<RoutinesList choice={c.value} />);
    await click(button(edit, 'Edit'));
    const editForm = edit.querySelector('form')!;
    expect((editForm.querySelector('input[disabled]') as HTMLInputElement).value).toBe('Morning check');
    await type([...editForm.querySelectorAll('label')].find(item => item.textContent!.startsWith('Time'))!.querySelector('input')!, '07:45');
    await click(button(editForm, 'Save'));
    expect(c.saved.at(-1)).toMatchObject({ name: 'Morning check', schedule: { kind: 'weekdays', days: [1, 2, 3, 4, 5], time: '07:45' } });
  });
});

describe('a bot\'s model and pause in the routines', () => {
  it('offers the models the provider lists in the form, keeps one the list no longer has, and saves the chosen one', async () => {
    const c = choice([routine({ model: 'retired-model' })], { models: [{ value: 'default', label: 'Default' }, { value: 'haiku', label: 'Haiku' }] });
    const container = await render(<RoutinesList choice={c.value} />);
    await click(button(container, 'Edit'));
    const select = container.querySelector('form select:not(:first-of-type), form label select[value], form select') as HTMLSelectElement;
    const model = [...container.querySelectorAll('form label')].find(item => item.textContent!.startsWith('Model'))!.querySelector('select') as HTMLSelectElement;
    expect([...model.options].map(option => option.value)).toEqual(['', 'default', 'haiku', 'retired-model']);
    expect(select).toBeTruthy();
    await type(model, 'haiku');
    await click(button(container.querySelector('form')!, 'Save'));
    expect(c.saved.at(-1)).toMatchObject({ name: 'Morning check', model: 'haiku' });
  });
  it('switches this bot\'s unattended work off and on', async () => {
    const calls: boolean[] = [];
    const container = await render(<RoutinesList choice={choice([routine()], { botPaused: false, pauseBot: async paused => { calls.push(paused); } }).value} />);
    await click(container.querySelector('[role="switch"], input[type="checkbox"]'));
    expect(calls).toEqual([true]);
    expect(container.textContent).toContain('Pause this bot\'s unattended work');
  });
});

describe('creating every kind of routine from the form', () => {
  const hookUrl = (token: string) => `https://relay.test/hooks/ns/${token}`;
  it('makes each schedule kind: every, daily, weekdays, once, quiet and a webhook, with its own fields', async () => {
    const c = choice([], { hookUrl });
    const container = await render(<RoutinesList choice={c.value} />);
    const make = async (name: string, kind: string, fill: (form: HTMLFormElement, field: (label: string) => HTMLInputElement) => Promise<void>) => {
      await click(button(container, 'New routine'));
      const form = container.querySelector('form')!;
      const field = (label: string) => [...form.querySelectorAll('label')].find(item => item.textContent!.startsWith(label))!.querySelector('input, select, textarea') as HTMLInputElement;
      await type(field('Name'), name); await type(field('When') as unknown as HTMLSelectElement, kind);
      await fill(form, field);
      await click(button(form, 'Save'));
    };
    await make('A', 'every', async (_, field) => { await type(field('Minutes'), '15'); });
    await make('B', 'daily', async (_, field) => { await type(field('Time'), '07:30'); });
    await make('C', 'weekdays', async (_, field) => { await type(field('Time'), '18:00'); });
    await make('D', 'once', async (_, field) => { await type(field('Date and time'), '2026-12-24T10:00'); });
    await make('E', 'quiet', async (_, field) => { await type(field('Minutes'), '45'); });
    await make('F', 'event', async () => {});
    expect(c.saved.map(spec => spec.schedule)).toEqual([{ kind: 'every', minutes: 15 }, { kind: 'daily', time: '07:30' }, { kind: 'weekdays', days: [1, 2, 3, 4, 5], time: '18:00' },
      { kind: 'once', at: Date.parse('2026-12-24T10:00:00Z') }, { kind: 'quiet', minutes: 45 }, { kind: 'event' }]);
  });
  it('offers the webhook only where the Relay has a public address, warns before saving one, and lets the person allow changes', async () => {
    const without = await render(<RoutinesList choice={choice([]).value} />);
    await click(button(without, 'New routine'));
    expect([...without.querySelectorAll('form select option')].map(option => option.textContent)).not.toContain('When a webhook is called');
    const c = choice([], { hookUrl: token => `https://relay.test/hooks/ns/${token}` });
    const container = await render(<RoutinesList choice={c.value} />);
    await click(button(container, 'New routine'));
    const form = container.querySelector('form')!;
    const when = [...form.querySelectorAll('label')].find(item => item.textContent!.startsWith('When'))!.querySelector('select') as HTMLSelectElement;
    await type(when, 'event');
    expect(form.querySelector('[role="note"]')!.textContent).toContain('full permissions');
    expect(form.querySelector('[role="note"]')!.textContent).toContain('read-only');
    await type([...form.querySelectorAll('label')].find(item => item.textContent!.startsWith('Name'))!.querySelector('input')!, 'Deploy failed');
    await click([...form.querySelectorAll('label')].find(item => item.textContent!.includes('change files'))!.querySelector('input'));
    await click(button(form, 'Save'));
    expect(c.saved).toEqual([{ name: 'Deploy failed', schedule: { kind: 'event' }, workspace: 'same' }]);
  });
  it('shows a new webhook address once with Copy, and a new one after Rotate, and says how many events wait', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { written.push(text); } } });
    const hook = routine({ id: 'h', name: 'Deploy failed', schedule: { kind: 'event' }, events: ['a', 'b'], runs: [] });
    const c = choice([hook], { hookUrl: token => `https://relay.test/hooks/ns/${token}`, rotateHook: async () => ({ token: 'abc.def' }) });
    const container = await render(<RoutinesList choice={c.value} />);
    expect(container.textContent).toContain('Anyone with its address can start this');
    expect(container.textContent).toContain('2 events waiting');
    expect(container.querySelector('.lab-routine-address')).toBeNull();
    await click(button(container, 'New address'));
    expect(container.querySelector('.lab-routine-address code')!.textContent).toBe('https://relay.test/hooks/ns/abc.def');
    await click(button(container.querySelector('.lab-routine-address')!, 'Copy address'));
    expect(written).toEqual(['https://relay.test/hooks/ns/abc.def']);
    expect(container.querySelector('.lab-routine-address')!.textContent).toContain('Copied');
  });
});

describe('the form\'s schedule', () => {
  const draft = (extra: Record<string, unknown>) => ({ name: 'A', kind: 'every', minutes: '30', time: '09:00', days: [1], at: '', prompt: '', model: '', maxRuns: '', ...extra }) as Parameters<typeof specOf>[0];
  it('takes only what the Relay would take, and reads a once time in the person\'s zone', () => {
    expect(specOf(draft({}), 'UTC')).toEqual({ name: 'A', schedule: { kind: 'every', minutes: 30 } });
    expect(specOf(draft({ minutes: '4' }), 'UTC')).toBeUndefined();
    expect(specOf(draft({ kind: 'quiet', minutes: '1' }), 'UTC')).toEqual({ name: 'A', schedule: { kind: 'quiet', minutes: 1 } });
    expect(specOf(draft({ name: ' ' }), 'UTC')).toBeUndefined();
    expect(specOf(draft({ kind: 'weekdays', days: [] }), 'UTC')).toBeUndefined();
    expect(specOf(draft({ kind: 'once', at: '2026-12-04T09:00' }), 'Asia/Tokyo')).toEqual({ name: 'A', schedule: { kind: 'once', at: Date.parse('2026-12-04T00:00:00Z') } });
    expect(specOf(draft({ kind: 'once', at: '' }), 'UTC')).toBeUndefined();
  });
});
