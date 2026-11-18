// @vitest-environment node
import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { writeResourceDraft, readResourceDraft, clearResourceDraftScope } from './resource-drafts.js';
it('retains exact file bytes across a draft reload and clears only its authority', async () => {
  const key = JSON.stringify(['scope-one', 'session']); const other = JSON.stringify(['scope-two', 'session']);
  const entry = { records: { one: { id: 'one', name: 'fixture.zip', file: new Blob([new Uint8Array([0, 255, 7])]), status: 'pending' as const, progress: 0 } }, hydrated: true, nextLabel: 2, revision: 0 };
  await writeResourceDraft(key, entry); await writeResourceDraft(other, entry);
  const saved = await readResourceDraft(key); expect(saved?.nextLabel).toBe(2);
  expect(Array.from(new Uint8Array(await saved!.records.one!.file.arrayBuffer()))).toEqual([0, 255, 7]);
  await clearResourceDraftScope('scope-one'); expect(await readResourceDraft(key)).toBeUndefined(); expect(await readResourceDraft(other)).toBeDefined();
  await clearResourceDraftScope('scope-two');
});
it('deletes removed file bytes and frees a draft slot even when storage is full', async () => {
  const entry = { records: { one: { id: 'one', name: 'fixture.zip', file: new Blob(['file']), status: 'pending' as const, progress: 0 } }, hydrated: true, nextLabel: 2, revision: 0 };
  const key = (index: number) => JSON.stringify(['full-storage', `session-${index}`]);
  try {
    for (let index = 0; index < 32; index++) await writeResourceDraft(key(index), entry);
    await expect(writeResourceDraft(key(32), entry)).rejects.toThrow();
    await writeResourceDraft(key(33), { ...entry, records: {} });
    expect(await readResourceDraft(key(33))).toBeUndefined();
    await writeResourceDraft(key(0), { ...entry, records: {} });
    expect(await readResourceDraft(key(0))).toBeUndefined();
    await writeResourceDraft(key(32), entry);
    expect(await readResourceDraft(key(32))).toBeDefined();
  } finally { await clearResourceDraftScope('full-storage'); }
});
