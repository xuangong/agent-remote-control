import { createRef } from 'react';
import { expect, it, vi } from 'vitest';
import type { RemoteAgentTransport } from '@orchardworks/agent-client';
import { DraftStore } from '../../kernel/draft-store.js';
import { render } from '../../test/setup.js';
import { AskConversation } from './AskConversation.js';

const source = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'main', title: 'Main' };
function ask(entry: { busy?: boolean; error?: string }, onClose = () => {}) {
  const scope = 'http://localhost/u/ask-opening/';
  return render(<AskConversation entry={{ source, ...entry } as never} transport={{} as RemoteAgentTransport} draftBinding={{ store: new DraftStore(scope), key: 'ask' }} storageScope={scope}
    triggerRef={createRef<HTMLButtonElement>()} onClose={onClose} onToggleEnabled={() => {}} onClean={() => {}} onRetry={() => {}} onSendInput={() => {}} onDiscardInput={() => {}} />);
}

it('says Opening Ask while its conversation is being created, and invites a question once it is ready for one', async () => {
  const opening = await ask({ busy: true });
  expect(opening.querySelector('.lab-ask-opening')?.textContent).toBe('Opening Ask…');
  const idle = await ask({});
  expect(idle.querySelector('.lab-ask-opening')?.textContent).not.toBe('Opening Ask…');
});

it('minimizes on the × button', async () => {
  const close = vi.fn();
  const view = await ask({}, close);
  view.querySelector<HTMLButtonElement>('[aria-label="Minimize Ask"]')!.click();
  expect(close).toHaveBeenCalledOnce();
});
