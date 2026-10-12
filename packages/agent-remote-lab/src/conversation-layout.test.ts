import { expect, it } from 'vitest';
import { createCompositionDocument, createCompositionSlot } from './session-composition.js';
import { applyConversationLayout, isConversationLayout, resolveConversationLayout } from './conversation-layout.js';

function fixture() {
  return createCompositionDocument('scope', ['main', 'child', 'other', 'other-child'].map(id => createCompositionSlot(id,
    { hostId: 'host', providerId: 'codex', nativeSessionId: id, title: id }, 'scope')));
}
it('restores only the requested presentation and resolves current native identities', () => {
  const document = fixture();
  document.edges = [{ source: 'other', target: 'other-child', selected: true }];
  document.slots[0]!.intent = { kind: 'role', roleKey: 'role', revision: 2, target: { hostId: 'host', native: { controllerId: 'installation', providerId: 'codex', nativeSessionId: 'successor' } } };
  const saved = { primarySlot: 'main', selections: { main: 'child', child: null }, focus: 'child', address: 'child' };
  expect(resolveConversationLayout(document, saved)?.primary.nativeSessionId).toBe('successor');
  const slots = structuredClone(document.slots);
  expect(applyConversationLayout(document, saved)).toBe(true);
  expect(document.edges).toEqual([{ source: 'other', target: 'other-child', selected: true }, { source: 'main', target: 'child', selected: true }]);
  expect(document).toMatchObject({ primary: 'main', focus: 'child', address: 'child' });
  expect(document.slots).toEqual(slots);
});
it('bounds paths and drops missing or cyclic references without inventing sessions', () => {
  const document = fixture();
  expect(resolveConversationLayout(document, { primarySlot: 'removed', selections: {} })).toBeUndefined();
  expect(resolveConversationLayout(document, { primarySlot: 'main', selections: { main: 'child', child: 'main' }, focus: 'removed' })).toMatchObject({ selections: { main: 'child', child: null }, focus: 'main' });
  expect(resolveConversationLayout(document, { primarySlot: 'main', selections: { main: 'removed' } })).toMatchObject({ selections: { main: null } });
  for (const value of [null, [], {}, { primarySlot: 'main', selections: [] }, { primarySlot: 'main', selections: { main: 42 } }]) expect(isConversationLayout(value)).toBe(false);
});
