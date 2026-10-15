import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createReplicaState } from '../replica/reducer.js';
import { inspectImageDraft, readImageDraft, writeImageDraft, type ImageDraft } from '../image-drafts.js';
import { AgentComposer } from './AgentComposer.js';
import { render, unmount } from '../test/setup.js';

vi.mock('../image-drafts.js', async importOriginal => ({ ...await importOriginal<typeof import('../image-drafts.js')>(),
  readImageDraft: vi.fn(), writeImageDraft: vi.fn() }));
beforeEach(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => vi.restoreAllMocks());

async function setup(withImage = false) {
  const scope = crypto.randomUUID(), binding = { scope, key: scope };
  let disk: ImageDraft = { version: 1, ...binding, parts: [], images: {}, nextLabel: 1 };
  let retainedText = '', current = true, changeText!: (value: string) => void, blockAuthority!: () => void, replaceRecipient!: () => void, replaceOwner!: () => void;
  const recipient = { identity: scope, lifetime: {}, isCurrent: () => current };
  const state = createReplicaState();
  state.timeline.initialized = true;
  state.agent = { id: 'A', providerId: 'test', createdAt: 'now', updatedAt: 'now', status: 'idle', activeTurn: null,
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
      ...(withImage ? { imageInput: { mediaTypes: ['image/png' as const], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 } } : {}) }, pendingInteractions: [],
    runtimeInfo: { providerId: 'test', sessionId: 'A', status: 'idle' } };
  const persist = async (value: ImageDraft) => { disk = structuredClone(value); return { status: 'saved' as const, retention: 'local' as const }; };
  vi.mocked(readImageDraft).mockReset().mockImplementation(async () => structuredClone(disk));
  vi.mocked(writeImageDraft).mockReset().mockImplementation(persist);
  const send = vi.fn(async () => { throw new Error('Native rejected input.'); });
  const richSend = vi.fn(async () => { throw new Error('Native rejected input.'); });
  const attachment = { attachmentId: 'image-A', sha256: 'a'.repeat(64), mediaType: 'image/png' as const, byteLength: 1, imageDimensions: { width: 1, height: 1 } };
  const upload = vi.fn(async () => attachment);
  function Harness() {
    const [text, setText] = useState(retainedText); changeText = setText;
    const [blocked, setBlocked] = useState(false); blockAuthority = () => setBlocked(true);
    const [selectedRecipient, setRecipient] = useState(recipient); replaceRecipient = () => setRecipient({ ...recipient, lifetime: {} });
    const [selectedBinding, setBinding] = useState(binding); replaceOwner = () => setBinding({ ...binding, key: `${binding.key}:other` });
    return <AgentComposer state={state} draft={text} mutationBlocked={blocked} imageDraftBinding={selectedBinding} imageRecipient={selectedRecipient}
      onDraftChange={value => { retainedText = value; setText(value); }} onSendMessage={send} onSendMessageContent={richSend} onUploadImage={upload} />;
  }
  const view = await render(<Harness />);
  if (withImage) await act(async () => {
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [new File(['x'], 'x.png', { type: 'image/png' })], getData: () => '' } });
    view.querySelector('[data-testid="prompt-input"]')!.dispatchEvent(paste);
  });
  let release!: () => void, fail!: () => void;
  vi.mocked(writeImageDraft).mockClear().mockImplementationOnce(value => new Promise((resolve, reject) => {
    release = () => { void persist(value).then(resolve); };
    fail = () => reject(new Error('Storage failed.'));
  }));
  await act(async () => {
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [], getData: (type: string) => type === 'text/plain' ? 'rejected draft' : '' } });
    view.querySelector('[data-testid="prompt-input"]')!.dispatchEvent(paste);
  });
  await act(async () => view.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
  return { view, send, richSend, binding, getDisk: () => disk, release: () => release(), fail: () => fail(), retire: () => { current = false; },
    blockAuthority: () => blockAuthority(), replaceRecipient: () => replaceRecipient(), replaceOwner: () => replaceOwner(),
    changeText: (value: string) => changeText(value), reload: async () => { await unmount(view); return render(<Harness />); } };
}

it('retains the submitted document before dispatch and restores it after rejection and completed hydration', async () => {
  const f = await setup();
  expect(f.send).not.toHaveBeenCalled();
  expect(writeImageDraft).toHaveBeenCalledWith(expect.objectContaining({ parts: [{ type: 'text', text: 'rejected draft' }] }), 0);
  await act(async () => f.release());
  expect(f.send).toHaveBeenCalledExactlyOnceWith('rejected draft');
  expect(f.getDisk().parts).toEqual([{ type: 'text', text: 'rejected draft' }]);
  let hydrate!: (draft: ImageDraft) => void;
  vi.mocked(readImageDraft).mockImplementationOnce(() => new Promise(resolve => { hydrate = resolve; }));
  const reloaded = await f.reload();
  expect(reloaded.querySelector('[aria-label="Live provider controls"]')?.getAttribute('aria-busy')).toBe('true');
  await act(async () => hydrate(structuredClone(f.getDisk())));
  expect(reloaded.querySelector('[aria-label="Live provider controls"]')?.getAttribute('aria-busy')).toBe('false');
  expect(reloaded.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('rejected draft');
  expect(f.getDisk().parts).toEqual([{ type: 'text', text: 'rejected draft' }]);
});

it.each(['newer edit', 'text ABA', 'recipient retirement', 'replacement recipient', 'document owner', 'native authority', 'storage failure'] as const)('never dispatches a retained send after %s during storage', async boundary => {
  const f = await setup();
  expect(writeImageDraft).toHaveBeenCalledOnce();
  expect(f.send).not.toHaveBeenCalled();
  await act(async () => {
    if (boundary === 'newer edit' || boundary === 'text ABA') f.changeText('newer draft');
    if (boundary === 'recipient retirement') f.retire();
    if (boundary === 'replacement recipient') f.replaceRecipient();
    if (boundary === 'document owner') f.replaceOwner();
    if (boundary === 'native authority') f.blockAuthority();
  });
  if (boundary === 'text ABA') await act(async () => f.changeText('rejected draft'));
  const preserved = f.view.querySelector('[data-testid="prompt-input"]')?.textContent;
  await act(async () => boundary === 'storage failure' ? f.fail() : f.release());
  expect(f.send).not.toHaveBeenCalled();
  expect(f.richSend).not.toHaveBeenCalled();
  expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe(preserved);
  if (boundary !== 'document owner') expect(preserved).toBe(boundary === 'newer edit' ? 'newer draft' : 'rejected draft');
});

it('does not dispatch an old attachment snapshot after an image-only revision change during retention', async () => {
  const f = await setup(true);
  expect(writeImageDraft).toHaveBeenCalledOnce();
  expect(f.send).not.toHaveBeenCalled(); expect(f.richSend).not.toHaveBeenCalled();
  const writer = await inspectImageDraft(f.binding);
  const before = writer.snapshot();
  expect(before.draft.parts.some(part => part.type === 'image')).toBe(true);
  let replaced!: Promise<unknown>;
  await act(async () => { replaced = writer.replace!(before.revision, { ...before.draft, parts: [{ type: 'text', text: 'rejected draft' }], images: {} }, () => true); });
  expect(writer.snapshot().revision).toBeGreaterThan(before.revision);
  await act(async () => { f.release(); await replaced; });
  expect(f.send).not.toHaveBeenCalled(); expect(f.richSend).not.toHaveBeenCalled();
  expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('rejected draft');
  expect(f.view.querySelector('[data-image-id]')).toBeNull();
});

it('retains and dispatches the exact submitted text and uploaded image snapshot', async () => {
  const f = await setup(true);
  expect(writeImageDraft).toHaveBeenCalledOnce();
  expect(f.richSend).not.toHaveBeenCalled();
  await act(async () => f.release());
  expect(f.send).not.toHaveBeenCalled();
  expect(f.richSend).toHaveBeenCalledExactlyOnceWith([
    { type: 'image', attachmentId: 'image-A', label: 'image #1' },
    { type: 'text', text: 'rejected draft' },
  ], { imageDigests: { 'image-A': 'a'.repeat(64) } });
  expect(f.getDisk().parts).toEqual([
    expect.objectContaining({ type: 'image', label: 'image #1' }),
    { type: 'text', text: 'rejected draft' },
  ]);
});
