import { describe, expect, it } from 'vitest';
import { COMMIT_SHARE, EDGE_ZONE_PX, EdgeSwipe, FLICK_WIDTHS_PER_SECOND, LIST_PARALLAX, SCRIM_COVERED, StackLayers, poseAt, releaseTarget, settleDuration, swipeProgress } from './stack-transition.js';

describe('the two layers of the stack', () => {
  it('has the list at home with the conversation off to the right at progress 0, and the list shifted under the conversation at 1', () => {
    expect(poseAt(0)).toEqual({ conversation: 'translate3d(100%, 0, 0)', list: 'translate3d(0%, 0, 0)', scrim: 0 });
    expect(poseAt(1)).toEqual({ conversation: 'translate3d(0%, 0, 0)', list: `translate3d(${-LIST_PARALLAX * 100}%, 0, 0)`, scrim: SCRIM_COVERED });
  });
  it('moves both layers in step: the list shifts a fixed share of what the conversation covers', () => {
    const half = poseAt(0.5);
    expect(half.conversation).toBe('translate3d(50%, 0, 0)');
    expect(half.list).toBe(`translate3d(${-0.5 * LIST_PARALLAX * 100}%, 0, 0)`);
    expect(half.scrim).toBeCloseTo(SCRIM_COVERED / 2);
  });
  it('holds a progress outside the range at its end', () => {
    expect(poseAt(2)).toEqual(poseAt(1)); expect(poseAt(-1)).toEqual(poseAt(0));
  });
});

describe('where a released swipe settles', () => {
  it('maps the finger to progress across the width, from the conversation covering everything (1) to gone (0)', () => {
    expect(swipeProgress(10, 10, 400)).toBe(1);
    expect(swipeProgress(10, 210, 400)).toBeCloseTo(0.5);
    expect(swipeProgress(10, 900, 400)).toBe(0);
    expect(swipeProgress(10, -50, 400)).toBe(1);
  });
  it('commits Back past the share, and returns short of it', () => {
    expect(releaseTarget(1 - COMMIT_SHARE - 0.01, 0)).toBe(0);
    expect(releaseTarget(1 - COMMIT_SHARE + 0.01, 0)).toBe(1);
  });
  it('commits a fast flick from anywhere, and returns a slow drag that stopped short', () => {
    expect(releaseTarget(0.9, FLICK_WIDTHS_PER_SECOND + 0.1)).toBe(0);
    expect(releaseTarget(0.9, FLICK_WIDTHS_PER_SECOND - 0.1)).toBe(1);
  });
  it('takes a time in proportion to the way left', () => {
    expect(settleDuration(0, 1, 360)).toBe(360);
    expect(settleDuration(0.75, 1, 360)).toBe(90);
    expect(settleDuration(1, 1, 360)).toBe(0);
    expect(settleDuration(0, 1, 0)).toBe(0);
  });
});

describe('a finger from the left edge', () => {
  it('ignores a finger that starts away from the edge', () => {
    const swipe = new EdgeSwipe(400);
    expect(swipe.start(EDGE_ZONE_PX + 1, 300, 0)).toBe(false);
    expect(swipe.move(300, 300, 16)).toBe(1); expect(swipe.end()).toBeUndefined();
  });
  it('waits for a direction, then follows the finger and commits past the share', () => {
    const swipe = new EdgeSwipe(400);
    expect(swipe.start(5, 300, 0)).toBe(true);
    expect(swipe.move(8, 301, 16)).toBe(1); expect(swipe.state).toBe('pending');
    expect(swipe.move(45, 305, 32)).toBeCloseTo(1 - 40 / 400); expect(swipe.state).toBe('dragging');
    expect(swipe.move(205, 310, 48)).toBeCloseTo(0.5);
    expect(swipe.end()).toBe(0);
  });
  it('returns the conversation when released short and slow', () => {
    const swipe = new EdgeSwipe(400);
    swipe.start(5, 300, 0); swipe.move(40, 300, 100); swipe.move(100, 300, 600);
    expect(swipe.end()).toBe(1);
  });
  it('leaves a vertical start and a leftward start to the page', () => {
    const vertical = new EdgeSwipe(400);
    vertical.start(5, 300, 0); expect(vertical.move(8, 340, 16)).toBe(1); expect(vertical.state).toBe('rejected');
    expect(vertical.move(200, 340, 32)).toBe(1); expect(vertical.end()).toBeUndefined();
    const leftward = new EdgeSwipe(400);
    leftward.start(5, 300, 0); leftward.move(5, 300, 8); leftward.move(-20, 300, 16);
    expect(leftward.state).toBe('rejected');
  });
  it('can be cancelled by the system: the conversation returns', () => {
    const swipe = new EdgeSwipe(400);
    swipe.start(5, 300, 0); swipe.move(120, 300, 50);
    expect(swipe.cancel()).toBe(1);
    expect(swipe.end()).toBeUndefined();
  });
});

describe('the layers on screen', () => {
  const elements = () => {
    const make = () => document.createElement('div');
    return { root: make(), list: make(), conversation: make(), scrim: make() };
  };
  it('shows a pose as inline styles and leaves none behind at rest', () => {
    const els = elements(), layers = new StackLayers(els, { fullDuration: () => 0, easing: () => 'ease' });
    layers.show(0.5);
    expect(els.conversation.style.transform).toBe('translate3d(50%, 0, 0)');
    expect(els.scrim.style.opacity).toBe(String(SCRIM_COVERED / 2));
    expect('stacking' in els.root.dataset).toBe(true);
    layers.rest();
    expect(els.conversation.style.transform).toBe(''); expect(els.list.style.transform).toBe(''); expect(els.scrim.style.opacity).toBe('');
    expect('stacking' in els.root.dataset).toBe(false);
  });
  it('settles at once when motion is off, holding the end pose until rest', async () => {
    const els = elements(), layers = new StackLayers(els, { fullDuration: () => 0, easing: () => 'ease' });
    layers.show(0.3);
    await expect(layers.settle(0)).resolves.toBe(true);
    expect(els.conversation.style.transform).toBe('translate3d(100%, 0, 0)');
    expect(layers.progress).toBe(0);
  });
  it('animates both layers and the dimming with the same timing, and is taken over by a later settle', async () => {
    const els = elements(), started: { target: string; duration: number; easing: string }[] = [];
    const finish: Array<() => void> = [];
    for (const [name, el] of Object.entries(els)) (el as unknown as { animate: unknown }).animate = (_frames: unknown, options: KeyframeAnimationOptions) => {
      started.push({ target: name, duration: Number(options.duration), easing: String(options.easing) });
      let resolve!: () => void; const finished = new Promise<void>((done, fail) => { resolve = done; void fail; });
      finish.push(resolve);
      return { finished, cancel() {} };
    };
    const layers = new StackLayers(els, { fullDuration: () => 360, easing: () => 'ease-out' });
    layers.show(0);
    const first = layers.settle(1);
    expect(started).toEqual(['conversation', 'list', 'scrim'].map(target => ({ target, duration: 360, easing: 'ease-out' })));
    const second = layers.settle(0);
    for (const done of finish) done();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
  });
});
