import { act, Profiler } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { DraftStore } from '../draft-store.js';
import { clearConversationRecovery, readDrafts } from '../conversation-recovery.js';
import { conversationSessionStorage } from '../conversation-storage.js';
import { LabWorkbench } from './LabWorkbench.js';

afterEach(() => { clearConversationRecovery(); vi.restoreAllMocks(); vi.useRealTimers(); });
const input = (view: ParentNode) => view.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
async function type(view: ParentNode, text: string) {
  await act(async () => {
    const editor = input(view);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('shows a nonblocking draft save failure and retries newer text in the mounted workbench', async () => {
  vi.useFakeTimers();
  const store = new DraftStore('mounted-drafts');
  const view = await render(<LabWorkbench state={replicaState} sessionStatus="ready" actions={{}}
    draftBinding={{ store, key: 'one' }} composerNotice={<span>Existing composer notice</span>} />);
  expect(view.querySelector('[role="alert"]')).toBeNull();
  const write = vi.spyOn(conversationSessionStorage, 'setItem').mockImplementation(() => { throw new Error('Full'); });
  await type(view, 'First');
  input(view).focus();
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(view.querySelector('[role="alert"]')?.textContent).toContain('Draft is not saved');
  expect(view.textContent).toContain('Existing composer notice');
  expect(input(view).value).toBe('First'); expect(input(view).disabled).toBe(false);
  expect(document.activeElement).toBe(input(view));
  await type(view, 'Newer text');
  write.mockRestore();
  await act(async () => view.querySelector<HTMLButtonElement>('button[aria-label="Retry saving draft"]')!.click());
  expect(readDrafts('mounted-drafts')).toEqual({ one: 'Newer text' });
  expect(input(view).value).toBe('Newer text');
  expect(view.querySelector('[role="alert"]')).toBeNull();
  expect(view.textContent).toContain('Existing composer notice');
});

it('does not rerender an unrelated workbench on normal text saves', async () => {
  vi.useFakeTimers();
  const store = new DraftStore('separate-workbenches');
  const renders = vi.fn();
  const view = await render(<>
    <section data-view="first"><LabWorkbench state={replicaState} sessionStatus="ready" actions={{}} draftBinding={{ store, key: 'one' }} /></section>
    <Profiler id="second" onRender={renders}><section data-view="second"><LabWorkbench state={replicaState} sessionStatus="ready" actions={{}} draftBinding={{ store, key: 'two' }} /></section></Profiler>
  </>);
  renders.mockClear();
  await type(view.querySelector('[data-view="first"]')!, 'Only one draft');
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(renders).not.toHaveBeenCalled();
  expect(input(view.querySelector('[data-view="second"]')!).value).toBe('');
  expect(view.querySelector('[role="alert"]')).toBeNull();
});
