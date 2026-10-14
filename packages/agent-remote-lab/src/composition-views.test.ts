import { describe, expect, it } from 'vitest';
import * as model from './session-composition.js';

const setup = () => model.createCompositionDocument('views', ['a', 'b'].map(id => model.createCompositionSlot(id,
  { hostId: 'host', providerId: 'codex', nativeSessionId: id, title: id }, 'views')));

describe('independent view bindings', () => {
  it('creates a durable empty view without a native session or slot', () => {
    const document = setup();
    const view = model.createCompositionView(document);
    expect(view.slotId).toBeUndefined();
    expect(document.slots).toHaveLength(2);
    expect(model.parseComposition(JSON.parse(JSON.stringify(document)), 'views').windows).toEqual([view]);
  });

  it('binds from empty and changes session without changing the view or either session owner', () => {
    const document = setup(), slots = structuredClone(document.slots);
    const view = model.createCompositionView(document), id = view.id;
    model.bindCompositionView(document, id, 'a');
    model.bindCompositionView(document, id, 'b');
    expect(view).toMatchObject({ id, slotId: 'b' });
    expect(document.primary).toBe('a');
    expect(document.slots).toEqual(slots);
    const revision = document.editRevision;
    model.bindCompositionView(document, id, 'b');
    expect(document.editRevision).toBe(revision);
    expect(() => model.bindCompositionView(document, id, '')).toThrow();
  });

  it('keeps explicit main selection and rejects sidebar replacement of managed or closed views', () => {
    const document = setup(), view = model.createCompositionView(document);
    view.managed = true;
    expect(() => model.bindCompositionView(document, view.id, 'b')).toThrow();
    expect(() => model.bindCompositionView(document, 'closed', 'b')).toThrow();
    model.bindCompositionView(document, 'main', 'b');
    expect(document.primary).toBe('b');
    expect(document.address).toBe('b');
    expect(view.slotId).toBeUndefined();
  });

  it('follows the existing composition binding rather than retaining a stale native target', () => {
    const document = setup(), view = model.createCompositionView(document);
    model.bindCompositionView(document, view.id, 'a');
    document.slots[0]!.intent = { kind: 'role', roleKey: 'role', revision: 2,
      target: { hostId: 'host', native: { controllerId: 'controller', providerId: 'copilot', nativeSessionId: 'successor' } } };
    const restored = model.parseComposition(JSON.parse(JSON.stringify(document)), 'views');
    expect(model.compositionSelection(restored.slots.find(slot => slot.id === restored.windows![0]!.slotId)!))
      .toMatchObject({ providerId: 'copilot', nativeSessionId: 'successor' });
  });
});
