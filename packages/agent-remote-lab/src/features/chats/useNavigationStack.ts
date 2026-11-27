/**
 * The phone's navigation stack as Bot mode shows it: the list is home, a conversation slides over it, Back and an edge swipe slide it
 * away. This hook owns the motion (stack-transition.ts has the rules); the workspace owns what each layer shows.
 *
 * - A push or a pop keeps both layers on screen until it ends: `motion` says which, `leavingKey` which conversation is sliding out.
 * - An edge swipe, from the strip along the conversation's left edge, follows the finger with both layers; `peek` says the list must be on screen under the conversation while it does.
 *   A release past halfway asks the page to go back and carries on from where the finger left; any other release returns.
 * - A touch the system takes over (the browser's or the installed app's own swipe back, which draws its own slide) cancels the pointer; a
 *   page that goes back soon after it is the system's, and slides nothing of its own.
 * - Motion off, by the system or by the reader's own choice, settles every transition at once: the durations are read from the
 *   motion tokens, which the page zeroes in both cases.
 * - On a wide screen nothing moves.
 */
import { useLayoutEffect, useRef, useState, useEffect, type RefObject } from 'react';
import { EdgeSwipe, StackLayers } from './stack-transition.js';

type Motion = 'push' | 'pop';

export interface NavigationStackInput {
  root: RefObject<HTMLElement | null>; list: RefObject<HTMLElement | null>;
  phone: boolean; showConversation: boolean;
  /** The conversation on screen, while one is. */
  shownKey: string | undefined;
  /** Goes back from the conversation, as the Back button does. */
  onBack(): void;
}

/** How long after a touch the system took, a pop is the system's own and is not slid again. */
const SYSTEM_BACK_WINDOW_MS = 800;

const tokenMilliseconds = (element: Element, token: string): number => {
  const value = getComputedStyle(element).getPropertyValue(token).trim();
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? (value.endsWith('ms') ? number : number * 1000) : 0;
};

export function useNavigationStack({ root, list, phone, showConversation, shownKey, onBack }: NavigationStackInput) {
  const conversation = useRef<HTMLElement>(null), scrim = useRef<HTMLDivElement>(null), edge = useRef<HTMLDivElement>(null);
  const [motion, setMotion] = useState<Motion>();
  const [leavingKey, setLeavingKey] = useState<string>();
  const [peek, setPeek] = useState(false);
  const chat = phone && showConversation;
  const layersRef = useRef<StackLayers>();
  const swiping = useRef(false), committed = useRef<Promise<boolean>>(), systemTouchAt = useRef(-Infinity), holdTimer = useRef<ReturnType<typeof setTimeout>>();
  const latest = useRef({ chat, onBack }); latest.current = { chat, onBack };
  const layers = (): StackLayers | undefined => {
    const elements = { root: root.current, list: list.current, conversation: conversation.current, scrim: scrim.current };
    if (!elements.root || !elements.list || !elements.conversation || !elements.scrim) return;
    return layersRef.current ??= new StackLayers(elements as ConstructorParameters<typeof StackLayers>[0], {
      fullDuration: () => tokenMilliseconds(elements.root!, '--orchard-duration-pop'),
      easing: () => getComputedStyle(elements.root!).getPropertyValue('--orchard-ease-standard').trim() || 'ease',
    });
  };

  // The conversation last on screen is the one a pop slides away, so it is remembered in the render that leaves it.
  if (shownKey && shownKey !== leavingKey) setLeavingKey(shownKey);
  // A change between the list and a conversation starts a push or a pop in the render that shows it, so no frame shows one layer alone.
  const [wasChat, setWasChat] = useState(chat);
  if (wasChat !== chat) {
    setWasChat(chat);
    const systemBack = !chat && performance.now() - systemTouchAt.current < SYSTEM_BACK_WINDOW_MS;
    const animates = !!root.current && !systemBack && tokenMilliseconds(root.current, '--orchard-duration-pop') > 0;
    setMotion(animates && phone ? (chat ? 'push' : 'pop') : undefined);
  }

  useLayoutEffect(() => {
    const stack = layers();
    if (!stack) return;
    if (!motion) { if (!swiping.current) { clearTimeout(holdTimer.current); committed.current = undefined; stack.rest(); setPeek(false); } return; }
    let run: Promise<boolean>;
    if (committed.current) run = committed.current;
    else {
      const from = stack.busy ? stack.visualProgress() : motion === 'push' ? 0 : 1;
      stack.show(from);
      run = stack.settle(motion === 'push' ? 1 : 0);
    }
    void run.then(finished => { if (finished) { committed.current = undefined; setMotion(undefined); } });
  }, [motion, chat]);

  // An edge swipe: a finger that starts on the strip along the conversation's left edge drags the conversation away, and the list shows underneath.
  // The strip is the part of the screen whose touch action leaves horizontal movement to the page: under it, the timeline would take the
  // gesture for a scroll of its own and cancel the pointer.
  useEffect(() => {
    const element = edge.current;
    if (!element || !phone) return;
    let swipe: EdgeSwipe | undefined, pointer = -1;
    const end = () => {
      swipe = undefined; swiping.current = false;
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel);
    };
    const settleBack = () => { const stack = layers(); if (stack) void stack.settle(1).then(finished => { if (finished && !swiping.current) { stack.rest(); setPeek(false); } }); else setPeek(false); };
    function move(event: PointerEvent) {
      if (event.pointerId !== pointer || !swipe) return;
      const progress = swipe.move(event.clientX, event.clientY, event.timeStamp);
      if (swipe.state === 'dragging') layers()?.show(progress);
      else if (swipe.state === 'rejected') { end(); setPeek(false); }
    }
    function up(event: PointerEvent) {
      if (event.pointerId !== pointer || !swipe) return;
      const target = swipe.end(); end();
      const stack = layers();
      if (target === 0 && stack) { committed.current = stack.settle(0); latest.current.onBack(); }
      else if (target === 1) settleBack();
      else setPeek(false);
    }
    function cancel(event: PointerEvent) {
      if (event.pointerId !== pointer || !swipe) return;
      const target = swipe.cancel(); end();
      systemTouchAt.current = performance.now();
      // The conversation holds where the finger left it: the system's back, if it comes, takes it from there with nothing slid back and
      // forth; only when none comes does the conversation return.
      if (target === 1) holdTimer.current = setTimeout(() => { if (latest.current.chat) settleBack(); }, SYSTEM_BACK_WINDOW_MS);
      else setPeek(false);
    }
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || !latest.current.chat || swipe || !root.current) return;
      clearTimeout(holdTimer.current);
      const next = new EdgeSwipe(root.current.clientWidth);
      if (!next.start(event.clientX, event.clientY, event.timeStamp)) return;
      swipe = next; pointer = event.pointerId; swiping.current = true; setPeek(true);
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel);
    };
    element.addEventListener('pointerdown', down);
    return () => { element.removeEventListener('pointerdown', down); clearTimeout(holdTimer.current); end(); };
  }, [phone]);

  return { motion, leavingKey, peek, conversation, scrim, edge };
}
