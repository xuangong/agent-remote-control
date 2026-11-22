import { describe, expect, it, vi } from 'vitest';
import { elementsOf, firstElement, buildSessionViewContext } from '../test/session-view-context.js';
import { mergeSessionViewContributions, type SessionViewContribution, type SessionViewContributions } from './session-view-contribution.js';

const commands = { deleteMessage: vi.fn(), retryMessage: vi.fn() };
const wrap = (name: string) => (actions: object) => ({ ...actions, wrapped: [...((actions as { wrapped?: string[] }).wrapped ?? []), name] });
const command = (id: string) => ({ id, name: id, kind: 'command' as const, description: id });

function contributions(overrides: Partial<Record<keyof SessionViewContributions, SessionViewContribution | readonly SessionViewContribution[]>> = {}): SessionViewContributions {
  return { forks: { commandSet: commands }, handoff: {}, quotes: {}, references: {}, outbox: {}, plain: [], ...overrides } as SessionViewContributions;
}
const merge = (overrides = {}, facts = {}) => mergeSessionViewContributions(buildSessionViewContext(facts), contributions(overrides));

describe('merging the contributions of a session view', () => {
  it('collects the props each contribution owns', () => {
    const props = merge({ forks: { commandSet: commands, props: { state: undefined } }, plain: [{ props: { headingMode: 'tile' } }, { props: { conversationTitle: 'T' } }] });
    expect(props).toMatchObject({ headingMode: 'tile', conversationTitle: 'T' });
    expect(props).toHaveProperty('state', undefined);
  });

  describe('actions', () => {
    it('wraps the forks commands with the quotes, then the references', () => {
      expect(merge({ quotes: { wrapActions: wrap('quotes') }, references: { wrapActions: wrap('references') } }).actions).toMatchObject({ wrapped: ['quotes', 'references'] });
      expect(merge({ references: { wrapActions: wrap('references') } }).actions).toMatchObject({ wrapped: ['references'] });
      expect(merge().actions).toBe(commands);
    });

    it('leaves only deleting a message while a fork input is pending', () => {
      expect(merge({ forks: { commandSet: commands, firstInputPending: true }, quotes: { wrapActions: wrap('quotes') } }).actions).toEqual({ deleteMessage: commands.deleteMessage });
    });

    it('takes the forks commands as they are in Bot mode', () => {
      const bot = merge({ forks: { commandSet: commands, firstInputPending: true }, quotes: { wrapActions: wrap('quotes') } }, { botPresentation: true });
      expect(bot.actions).toBe(commands);
    });
  });

  it('lists the console commands of the forks, then the handoff, then the references', () => {
    const props = merge({ forks: { commandSet: commands, consoleCommands: [command('fork')] }, handoff: { consoleCommands: [command('handoff')] }, references: { consoleCommands: [command('ref')] }, quotes: { consoleCommands: [command('quote')] } });
    expect(props.consoleCommands?.map(item => item.id)).toEqual(['fork', 'handoff', 'ref']);
  });

  describe('executing a console command', () => {
    it('lets the references answer before the source is checked, then checks the source, then asks the handoff and the forks in turn', async () => {
      const calls: string[] = [];
      const answer = (name: string, result?: object) => (id: string) => { calls.push(`${name}:${id}`); return result ? Promise.resolve(result) : undefined; };
      const view = buildSessionViewContext({ assertCurrent: () => { calls.push('assert'); } });
      const run = (parts: Partial<SessionViewContributions>) => mergeSessionViewContributions(view, contributions(parts)).onExecuteConsoleCommand!('x', '');
      await run({ references: { beforeSourceCheck: answer('references', { ref: true }) } });
      expect(calls).toEqual(['references:x']);
      calls.length = 0;
      await run({ references: { beforeSourceCheck: answer('references') }, handoff: { onConsoleCommand: answer('handoff', { handoff: true }) }, forks: { commandSet: commands, onConsoleCommand: answer('forks', { fork: true }) } });
      expect(calls).toEqual(['references:x', 'assert', 'handoff:x']);
      calls.length = 0;
      expect(await run({ handoff: { onConsoleCommand: answer('handoff') }, forks: { commandSet: commands, onConsoleCommand: answer('forks', { fork: true }) } })).toEqual({ fork: true });
      expect(calls).toEqual(['assert', 'handoff:x', 'forks:x']);
    });

    it('rejects when the source is no longer current, and when a handler throws', async () => {
      const view = buildSessionViewContext({ assertCurrent: () => { throw new Error('changed'); } });
      await expect(mergeSessionViewContributions(view, contributions()).onExecuteConsoleCommand!('x', '')).rejects.toThrow('changed');
      const throwing = contributions({ forks: { commandSet: commands, onConsoleCommand: () => { throw new Error('busy'); } } });
      await expect(mergeSessionViewContributions(buildSessionViewContext(), throwing).onExecuteConsoleCommand!('x', '')).rejects.toThrow('busy');
    });
  });

  it('puts the handoff progress before the quote status in the composer', () => {
    const props = merge({ handoff: { composerStatus: 'progress' }, quotes: { composerStatus: 'quotes' } });
    expect(elementsOf(props.composerStatus)).toEqual([]);
    expect(JSON.stringify(props.composerStatus)).toMatch(/progress.*quotes/);
  });

  it('puts the references before the quote attachments in the composer, and neither in Bot mode', () => {
    const parts = { references: { composerContext: 'references' }, quotes: { composerContext: 'quotes' } };
    expect(JSON.stringify(merge(parts).composerContext)).toMatch(/references.*quotes/);
    expect(merge(parts, { botPresentation: true }).composerContext).toBeUndefined();
  });

  it('takes the outbox hint for the composer notice, else the forks entries outside Bot mode', () => {
    const parts = { forks: { commandSet: commands, composerNotice: 'entries' } };
    expect(merge({ ...parts, outbox: { composerNotice: 'hint' } }).composerNotice).toBe('hint');
    expect(merge(parts).composerNotice).toBe('entries');
    expect(merge(parts, { botPresentation: true }).composerNotice).toBeUndefined();
    expect(merge({ ...parts, outbox: { composerNotice: 'hint' } }, { botPresentation: true }).composerNotice).toBe('hint');
  });

  it('blocks sending while any contribution blocks it or the Window is provisional', () => {
    expect(merge().mutationBlocked).toBe(false);
    expect(merge({ handoff: { blocksMutation: true } }).mutationBlocked).toBe(true);
    expect(merge({}, { provisional: true }).mutationBlocked).toBe(true);
  });
});
