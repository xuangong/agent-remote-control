import { act, useRef, useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { render, rerender } from '../test/setup.js';
import { useResourceDraft } from './useResourceDraft.js';
import { readResourceDraft, writeResourceDraft, resourceDraftMemory, type Entry } from '../resource-drafts.js';
import type { DraftPart } from './composer-document.js';
vi.mock('../resource-drafts.js', async original => ({ ...await original<typeof import('../resource-drafts.js')>(), readResourceDraft: vi.fn(), writeResourceDraft: vi.fn() }));
let draft!: ReturnType<typeof useResourceDraft>; let replaceParts!: (parts: DraftPart[]) => void;
const limits = { maxResources: 8, maxResourceBytes: 52428800, maxMessageBytes: 104857600 };
function Harness({ session = 's0', hydrated = true, initialParts = [] }: { session?: string; hydrated?: boolean; initialParts?: DraftPart[] }) {
  const parts = useRef(new Map<string, DraftPart[]>()); const [, refresh] = useState(0);
  if (!parts.current.has(session)) parts.current.set(session, initialParts);
  replaceParts = value => { parts.current.set(session, value); refresh(count => count + 1); };
  draft = useResourceDraft({ scope: 'test-scope', sessionKey: session, parts: parts.current.get(session)!, documentHydrated: hydrated, active: false, limits });
  return <span>{draft.items.map(item => item.record?.name ?? 'missing').join(',')}</span>;
}
beforeEach(() => { resourceDraftMemory.clear(); vi.mocked(readResourceDraft).mockReset().mockResolvedValue(undefined); vi.mocked(writeResourceDraft).mockReset().mockResolvedValue(undefined); });
it('retains a failed-to-save resource after visiting more than six sessions', async () => {
  vi.mocked(writeResourceDraft).mockRejectedValue(new Error('Quota denied'));
  const container = await render(<Harness />);
  const file = new File(['keep me'], 'important.zip');
  await act(async () => replaceParts(draft.add([file])));
  expect(draft.storageError).toContain('not saved');
  for (let i = 1; i <= 6; i++) await rerender(container, <Harness session={`s${i}`} />);
  await rerender(container, <Harness />);
  expect(draft.items[0]?.record?.file).toBe(file); expect(container.textContent).toBe('important.zip');
});
it('prunes a removed atom from the persisted resource records', async () => {
  const saved: Record<string, Entry['records']> = {};
  vi.mocked(writeResourceDraft).mockImplementation(async (key, entry) => { saved[key] = { ...entry.records }; });
  await render(<Harness />);
  await act(async () => replaceParts(draft.add([new File(['zip'], 'remove.zip')])));
  expect(Object.keys(saved['["test-scope","s0"]']!)).toHaveLength(1);
  await act(async () => replaceParts([]));
  expect(saved['["test-scope","s0"]']).toEqual({}); expect(draft.items).toHaveLength(0);
});
it('does not prune restored bytes before the document hydration completes', async () => {
  const file = new File(['saved'], 'saved.zip');
  vi.mocked(readResourceDraft).mockResolvedValue({ nextLabel: 2, records: { saved: { id: 'saved', name: file.name, file, status: 'pending', progress: 0 } } });
  const container = await render(<Harness hydrated={false} />);
  expect(writeResourceDraft).not.toHaveBeenCalled();
  await act(async () => replaceParts([{ type: 'resource', resourceId: 'saved', label: 'resource #1' }]));
  await rerender(container, <Harness hydrated />);
  expect(draft.items[0]?.record?.file).toBe(file); expect(writeResourceDraft).not.toHaveBeenCalled();
});
it('rejects another attachment when unsaved files fill memory without discarding those files', async () => {
  vi.mocked(writeResourceDraft).mockRejectedValue(new Error('Quota denied'));
  const container = await render(<Harness />);
  const files = ['one.zip', 'two.zip', 'three.zip'].map(name => {
    const file = new File(['bytes'], name);
    Object.defineProperty(file, 'size', { value: 50 * 1024 * 1024 });
    return file;
  });
  await act(async () => replaceParts(draft.add([files[0]!])));
  await rerender(container, <Harness session="s1" />);
  await act(async () => replaceParts(draft.add([files[1]!])));
  await rerender(container, <Harness session="s2" />);
  expect(() => draft.add([files[2]!])).toThrow('local memory budget');
  expect(draft.items).toHaveLength(0);
  await rerender(container, <Harness />);
  expect(draft.items[0]?.record?.file).toBe(files[0]);
  await rerender(container, <Harness session="s1" />);
  expect(draft.items[0]?.record?.file).toBe(files[1]);
});
it('retains files while their storage write is still pending across session changes', async () => {
  let finish!: () => void;
  vi.mocked(writeResourceDraft).mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const container = await render(<Harness />);
  const file = new File(['pending'], 'pending.zip');
  await act(async () => replaceParts(draft.add([file])));
  for (let i = 1; i <= 6; i++) await rerender(container, <Harness session={`s${i}`} />);
  await rerender(container, <Harness />);
  expect(draft.items[0]?.record?.file).toBe(file);
  await act(async () => finish());
  expect(draft.storageError).toBeUndefined();
});
