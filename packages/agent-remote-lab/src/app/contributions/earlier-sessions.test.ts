import { describe, expect, it, vi } from 'vitest';
import type { Translate } from '@orchardworks/agent-client';
import { buildSessionViewContext } from '../../test/session-view-context.js';
import { earlierSessionsContribution, type EarlierSessionsContributionInputs } from './earlier-sessions.js';

const t = ((key: string) => key) as Translate;
const chain = { predecessor: 'before' };
function setup(facts = {}) {
  const select = vi.fn(), earlierConversationFor = vi.fn(value => ({ earlier: value }));
  const inputs = { earlierConversationFor, navigation: { select }, succession: { historyNavigationFor: () => chain }, t } as unknown as EarlierSessionsContributionInputs;
  return { props: earlierSessionsContribution(inputs)(buildSessionViewContext(facts)).props!, select, earlierConversationFor };
}

describe('the sessions behind a view', () => {
  it('continues the conversation into the earlier sessions in Bot mode and in a bot of a Window', () => {
    expect(setup({ botPresentation: true }).props.timelineStart).toEqual({ earlier: chain });
    expect(setup({ windowBot: true }).props.timelineStart).toEqual({ earlier: chain });
  });

  it('keeps the handoff line of an ordinary view', () => {
    const { props, earlierConversationFor } = setup();
    expect(props.timelineStart).toBeUndefined();
    expect(earlierConversationFor).not.toHaveBeenCalled();
  });

  it('opens an attributed session in Bot mode with the attribution as its title, and a group only in a Window', async () => {
    const { props, select } = setup({ botPresentation: true });
    await props.onNavigateAttribution!({ target: { kind: 'session', nativeSessionId: 'n1' }, value: 'Title' } as never);
    expect(select).toHaveBeenCalledWith({ kind: 'session', session: { kind: 'session', nativeSessionId: 'n1', title: 'Title' } });
    await expect(props.onNavigateAttribution!({ target: { kind: 'group' } } as never)).rejects.toThrow('sessions.presentation.openInWindow');
    await props.onNavigateAttribution!({} as never);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('does not navigate attributions outside Bot mode', () => {
    expect(setup().props.onNavigateAttribution).toBeUndefined();
  });
});
