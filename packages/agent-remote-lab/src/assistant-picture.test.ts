import { describe, expect, it } from 'vitest';
import { applyGroupOperation, createWindowView, type WindowGroup, type WindowOperation } from '@orchardworks/agent-remote-protocol';
import { avatarFor, avatarShapeNames } from '@orchardworks/agent-client-web/theme';
import { buildGroup, buildView, buildWindow } from './test/window-builders.js';
import { newAssistantPicture, takenAvatars, withNewAssistantPicture } from './assistant-picture.js';

const pairOf = (picture: { shape: string; color: string }) => `${picture.shape}/${picture.color}`;
const groupOf = (viewIds: string[], pictures: Record<string, { shape: 'circle'; color: string }> = {}): WindowGroup => {
  const group = buildGroup(buildWindow(viewIds.map(id => buildView(id))));
  group.bots!.rank = 'm';
  for (const [id, picture] of Object.entries(pictures)) group.bots!.members[id] = { picture };
  return group;
};

describe('the avatars the account has taken', () => {
  it('counts a stored picture, and the generated avatar of a bot without one', () => {
    const generated = avatarFor('plain');
    const taken = takenAvatars([groupOf(['plain', 'stored'], { stored: { shape: 'circle', color: '#112233' } })]);
    expect(taken).toEqual([{ shape: generated.shape, color: generated.color }, { shape: 'circle', color: '#112233' }]);
  });
});

describe('a new assistant picture', () => {
  it('keeps the generated avatar of its id while nobody has it', () => {
    const generated = avatarFor('fresh');
    expect(newAssistantPicture('fresh', [])).toEqual({ shape: generated.shape, color: generated.color, gaze: generated.gaze });
  });
  it('differs from every other assistant while one of the pairs remains', () => {
    const groups: WindowGroup[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < 32; index++) {
      const id = `bot-${index}`, picture = newAssistantPicture(id, groups);
      expect(seen.has(pairOf(picture))).toBe(false);
      seen.add(pairOf(picture));
      groups.push(groupOf([id], { [id]: picture as never }));
    }
    expect(seen.size).toBe(32);
    expect(avatarShapeNames).toContain(newAssistantPicture('bot-33', groups).shape);
  });
});

describe('an operation that adds an assistant to a group', () => {
  const side = { ...createWindowView('side', { hostId: 'local', providerId: 'codex', nativeSessionId: 'side', title: 'side' }, 'attached'), attachedTo: 'main' };
  const operation: WindowOperation = { type: 'batch', operations: [{ type: 'view.create', view: side }, { type: 'view.select', viewId: 'side' }] };

  it('stores the picture of the new bot with the view, in a group that already has bot details', () => {
    const group = groupOf(['main']);
    const applied = applyGroupOperation(group, withNewAssistantPicture(group, [group], operation));
    expect(applied.window.views.map(view => view.id)).toEqual(['main', 'side']);
    expect(applied.bots!.members.side!.picture).toMatchObject({ shape: expect.any(String), color: expect.stringMatching(/^#[0-9a-f]{6}$/) });
  });
  it('makes a group without bot details a section first', () => {
    const group = buildGroup(buildWindow([buildView('main')]), { bots: false });
    const applied = applyGroupOperation(group, withNewAssistantPicture(group, [group], operation));
    expect(applied.bots!.members.side!.picture).toBeDefined();
  });
  it('leaves an operation that creates no bot as it is', () => {
    const group = groupOf(['main']);
    const select = { type: 'view.select', viewId: 'main' } as const;
    expect(withNewAssistantPicture(group, [group], select)).toBe(select);
  });
});
