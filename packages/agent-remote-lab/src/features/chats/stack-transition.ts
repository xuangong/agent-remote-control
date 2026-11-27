/**
 * The phone's navigation stack in motion: the conversation slides over the list, and the list underneath shifts a little and dims, as a
 * native stack does. Two layers move in step with one number, the progress (0: the list is home, 1: the conversation is shown).
 *
 * - `poseAt` is the pure map from progress to the two layers' transforms and the dimming layer's opacity.
 * - `EdgeSwipe` reads a finger that starts at the left edge: it waits for a direction, follows the finger and decides on release
 *   whether Back commits or the conversation returns to where it was.
 * - `StackLayers` applies a pose to the elements and settles one pose into another, by the Web Animations API when the page has it and
 *   when motion is allowed (a zero duration, from the device's choice or the reader's, settles at once).
 */

/** How much of its width the list shifts while the conversation covers it. */
export const LIST_PARALLAX = 0.3;
/** The dimming layer's opacity when the conversation fully covers the list. */
export const SCRIM_COVERED = 0.6;
/** A finger that starts within this many pixels of the left edge starts Back. */
export const EDGE_ZONE_PX = 24;
/** Movement before a direction is decided. */
export const DIRECTION_SLOP_PX = 8;
/** A release past this share of the width commits Back. */
export const COMMIT_SHARE = 0.4;
/** A release faster than this, in widths per second, commits Back wherever it is. */
export const FLICK_WIDTHS_PER_SECOND = 0.8;

export interface StackPose { readonly conversation: string; readonly list: string; readonly scrim: number }

const clamp = (value: number) => Math.min(1, Math.max(0, value));

export function poseAt(progress: number): StackPose {
  const p = clamp(progress);
  return { conversation: `translate3d(${(1 - p) * 100}%, 0, 0)`, list: `translate3d(${-p * LIST_PARALLAX * 100}%, 0, 0)`, scrim: p * SCRIM_COVERED };
}

/** The progress a finger at `x` shows, for a swipe that started at `startX` on a conversation `width` pixels wide. */
export function swipeProgress(startX: number, x: number, width: number): number {
  return width > 0 ? clamp(1 - (x - startX) / width) : 1;
}

/** Where a released swipe settles: 0 (Back commits) or 1 (the conversation stays). */
export function releaseTarget(progress: number, widthsPerSecond: number): 0 | 1 {
  return progress < 1 - COMMIT_SHARE || widthsPerSecond > FLICK_WIDTHS_PER_SECOND ? 0 : 1;
}

/** How long settling from one progress to another takes when a full push takes `full` ms: a short way takes a short time. */
export function settleDuration(from: number, to: number, full: number): number {
  return Math.round(full * Math.min(1, Math.abs(to - from)));
}

export type EdgeSwipeState = 'idle' | 'pending' | 'dragging' | 'rejected';
interface Sample { x: number; t: number }

/** One finger's swipe from the left edge. Times are given, never read, so a test drives it frame by frame. */
export class EdgeSwipe {
  state: EdgeSwipeState = 'idle';
  progress = 1;
  private startX = 0; private startY = 0;
  private samples: Sample[] = [];
  constructor(private readonly width: number) {}

  start(x: number, y: number, t: number): boolean {
    if (x > EDGE_ZONE_PX) { this.state = 'rejected'; return false; }
    this.state = 'pending'; this.progress = 1; this.startX = x; this.startY = y; this.samples = [{ x, t }];
    return true;
  }

  /** The progress to show for the finger now; unchanged while the direction is not decided or the swipe was rejected. */
  move(x: number, y: number, t: number): number {
    if (this.state === 'pending') {
      const dx = x - this.startX, dy = y - this.startY;
      if (Math.abs(dx) < DIRECTION_SLOP_PX && Math.abs(dy) < DIRECTION_SLOP_PX) return this.progress;
      // A vertical start is the conversation's own scroll; a leftward one has nothing to reveal.
      this.state = dx > 0 && dx >= Math.abs(dy) ? 'dragging' : 'rejected';
    }
    if (this.state !== 'dragging') return this.progress;
    this.samples.push({ x, t }); if (this.samples.length > 6) this.samples.shift();
    this.progress = swipeProgress(this.startX, x, this.width);
    return this.progress;
  }

  /** The finger lifted: the pose to settle to, or undefined when no swipe was under way. */
  end(): 0 | 1 | undefined {
    const dragging = this.state === 'dragging';
    const target = dragging ? releaseTarget(this.progress, this.speed()) : undefined;
    this.state = 'idle';
    return target;
  }

  /** The system took the touch (an edge gesture of its own, a call): the conversation returns to where it was. */
  cancel(): 1 | undefined {
    const dragging = this.state === 'dragging';
    this.state = 'idle';
    return dragging ? 1 : undefined;
  }

  private speed(): number {
    const first = this.samples[0], last = this.samples.at(-1);
    return first && last && last.t > first.t && this.width > 0 ? (last.x - first.x) / this.width / ((last.t - first.t) / 1000) : 0;
  }
}

export interface StackElements { readonly root: HTMLElement; readonly list: HTMLElement; readonly conversation: HTMLElement; readonly scrim: HTMLElement }
export interface StackPorts {
  /** How long a full push takes; zero when motion is reduced. */
  fullDuration(): number;
  easing(): string;
}

/** The two layers of the stack on screen. A pose is inline styles on them; settling animates from one pose to another and leaves no style behind. */
export class StackLayers {
  private animations: Animation[] = [];
  private current = 1;
  constructor(private readonly elements: StackElements, private readonly ports: StackPorts) {}

  get progress(): number { return this.current; }
  /** Whether an animation is running. */
  get busy(): boolean { return this.animations.length > 0; }
  /** Where the conversation is now, read from the screen: the progress to carry on from when a running animation is taken over. */
  visualProgress(): number {
    const root = this.elements.root.getBoundingClientRect(), conversation = this.elements.conversation.getBoundingClientRect();
    return root.width > 0 ? clamp(1 - (conversation.left - root.left) / root.width) : this.current;
  }

  show(progress: number): void {
    this.stop();
    this.current = clamp(progress);
    const { root, list, conversation, scrim } = this.elements, pose = poseAt(this.current);
    root.dataset.stacking = '';
    list.style.transform = pose.list; conversation.style.transform = pose.conversation; scrim.style.opacity = String(pose.scrim);
  }

  /** Settles into `to` (0 or 1) and resolves when the layers hold that pose, which stays until `rest()`; true when it ran to the end, false when something took over. */
  settle(to: 0 | 1): Promise<boolean> {
    const from = this.current, duration = settleDuration(from, to, this.ports.fullDuration());
    const { list, conversation, scrim } = this.elements;
    if (duration <= 0 || typeof conversation.animate !== 'function') { this.show(to); return Promise.resolve(true); }
    this.stop();
    const a = poseAt(from), b = poseAt(to), options = { duration, easing: this.ports.easing(), fill: 'forwards' as const };
    const animations = [
      conversation.animate([{ transform: a.conversation }, { transform: b.conversation }], options),
      list.animate([{ transform: a.list }, { transform: b.list }], options),
      scrim.animate([{ opacity: a.scrim }, { opacity: b.scrim }], options),
    ];
    this.animations = animations; this.current = to;
    return Promise.all(animations.map(animation => animation.finished)).then(() => {
      if (this.animations !== animations) return false;
      this.show(to); return true;
    }, () => false);
  }

  /** The layers at rest: no pose, no animation, as when no transition ever ran. */
  rest(progress: number = this.current): void {
    this.stop();
    this.current = clamp(progress);
    const { root, list, conversation, scrim } = this.elements;
    delete root.dataset.stacking;
    list.style.removeProperty('transform'); conversation.style.removeProperty('transform'); scrim.style.removeProperty('opacity');
  }

  private stop(): void {
    const running = this.animations; this.animations = [];
    for (const animation of running) animation.cancel();
  }
}
