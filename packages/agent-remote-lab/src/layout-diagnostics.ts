// Diagnostics are opt-in and page-local. Never read text, URLs, session IDs or storage.
const limits = { maxSamples: 800, frameWindowMs: 3000, recordingMs: 600_000 };
type StopReason = 'manual' | 'timeout' | 'pagehide' | 'unmount';
type Status = { recording: boolean; hasRecording: boolean; stopReason?: StopReason };
type ViewportDecision = { aligned: boolean; height: number; layoutHeight: number; referenceHeight: number; editing: boolean; occluded: boolean };
let status: Status = { recording: false, hasRecording: false };
const listeners = new Set<() => void>();
let samples: Record<string, unknown>[] = [];
let startedAt: string | null = null;
let stoppedAt: string | null = null;
let origin = 0;
let droppedSamples = 0;
let environment: Record<string, unknown> | null = null;
let cleanup: (() => void) | undefined;
let safeAreaProbe: HTMLDivElement | undefined;
let lastGeometry = '';

export function getLayoutDiagnosticsStatus() { return status; }
export function subscribeLayoutDiagnostics(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function publish(next: Status) { status = next; listeners.forEach(listener => listener()); }
const rounded = (value: number) => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;

function bounds(element: Element | null) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { x: rounded(rect.x), y: rounded(rect.y), width: rounded(rect.width), height: rounded(rect.height) };
}

function capture(reason: string, decision?: ViewportDecision) {
  if (!status.recording) return;
  const shell = document.querySelector<HTMLElement>('.lab-shell');
  const header = shell?.querySelector<HTMLElement>('.lab-mobile-navigation');
  const shellStyle = shell ? getComputedStyle(shell) : null;
  const headerStyle = header ? getComputedStyle(header) : null;
  const safeArea = safeAreaProbe ? getComputedStyle(safeAreaProbe) : null;
  const viewport = window.visualViewport;
  const root = document.documentElement;
  const active = document.activeElement;
  const geometry = {
    window: { width: innerWidth, height: innerHeight, scrollX: rounded(scrollX), scrollY: rounded(scrollY) },
    document: { width: root.clientWidth, height: root.clientHeight, scrollHeight: root.scrollHeight, scrollWidth: root.scrollWidth, scrollTop: rounded(document.scrollingElement?.scrollTop ?? 0) },
    viewport: viewport ? { width: rounded(viewport.width), height: rounded(viewport.height), offsetTop: rounded(viewport.offsetTop), offsetLeft: rounded(viewport.offsetLeft), pageTop: rounded(viewport.pageTop), pageLeft: rounded(viewport.pageLeft), scale: rounded(viewport.scale) } : null,
    shell: bounds(shell), header: bounds(header ?? null),
    composers: [...document.querySelectorAll('.lab-composer-dock')].slice(0, 4).map(bounds),
    shellStyle: shellStyle ? { top: shellStyle.top, height: shellStyle.height, position: shellStyle.position,
      viewportTop: shellStyle.getPropertyValue('--lab-viewport-top'), viewportHeight: shellStyle.getPropertyValue('--lab-viewport-height'), occluded: shell?.dataset.viewportOccluded ?? null } : null,
    headerStyle: headerStyle ? { paddingTop: headerStyle.paddingTop, height: headerStyle.height, display: headerStyle.display } : null,
    safeArea: safeArea ? { top: safeArea.paddingTop, bottom: safeArea.paddingBottom, left: safeArea.paddingLeft, right: safeArea.paddingRight } : null,
    orientation: screen.orientation?.type ?? null, angle: screen.orientation?.angle ?? null,
    visibility: document.visibilityState,
    focus: active?.matches('input, textarea') ? active.tagName.toLowerCase() : active?.matches('[contenteditable="true"], [contenteditable="plaintext-only"]') ? 'contenteditable' : 'other',
  };
  const signature = JSON.stringify(geometry);
  // Keep event boundaries, but do not fill the report with identical settled frames.
  if (reason === 'frame' && signature === lastGeometry) return;
  lastGeometry = signature;
  samples.push({ at: rounded(performance.now() - origin), reason, ...geometry, decision: decision ?? null });
  if (samples.length > limits.maxSamples) { samples.shift(); droppedSamples++; }
}

export function recordViewportDecision(phase: 'before' | 'after', decision: ViewportDecision) {
  capture(`viewport-${phase}`, decision);
}

export function startLayoutDiagnostics() {
  if (status.recording) return;
  samples = []; droppedSamples = 0; lastGeometry = '';
  startedAt = new Date().toISOString(); stoppedAt = null; origin = performance.now();
  environment = {
    userAgent: navigator.userAgent, pixelRatio: devicePixelRatio,
    screen: { width: screen.width, height: screen.height },
    standalone: matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
    coarsePointer: matchMedia('(pointer: coarse)').matches,
  };
  safeAreaProbe = document.createElement('div');
  safeAreaProbe.dataset.layoutSafeAreaProbe = '';
  safeAreaProbe.setAttribute('aria-hidden', 'true');
  safeAreaProbe.style.cssText = 'position:fixed;inset:0 auto auto 0;width:0;height:0;visibility:hidden;pointer-events:none;contain:strict;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.append(safeAreaProbe);
  let frame = 0;
  let until = 0;
  const removals: (() => void)[] = [];
  const tick = () => {
    frame = 0;
    if (!status.recording || document.hidden) return;
    capture('frame');
    if (performance.now() < until) frame = requestAnimationFrame(tick);
  };
  const transition = (reason: string) => {
    capture(reason);
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0; return; }
    until = performance.now() + limits.frameWindowMs;
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const listen = (target: EventTarget, name: string, reason = name) => {
    const handler = () => transition(reason);
    target.addEventListener(name, handler, { passive: true });
    removals.push(() => target.removeEventListener(name, handler));
  };
  for (const name of ['orientationchange', 'resize', 'scroll', 'pageshow', 'focus']) listen(window, name, `window-${name}`);
  for (const name of ['focusin', 'focusout', 'visibilitychange']) listen(document, name);
  if (window.visualViewport) for (const name of ['resize', 'scroll']) listen(window.visualViewport, name, `visualViewport-${name}`);
  if (screen.orientation) listen(screen.orientation, 'change', 'screen-orientation');
  const pagehide = () => stopLayoutDiagnostics('pagehide');
  window.addEventListener('pagehide', pagehide);
  const timeout = window.setTimeout(() => stopLayoutDiagnostics('timeout'), limits.recordingMs);
  cleanup = () => {
    clearTimeout(timeout); cancelAnimationFrame(frame);
    removals.forEach(remove => remove());
    window.removeEventListener('pagehide', pagehide);
    safeAreaProbe?.remove(); safeAreaProbe = undefined;
  };
  publish({ recording: true, hasRecording: true });
  transition('start');
}

export function stopLayoutDiagnostics(reason: StopReason = 'manual') {
  if (!status.recording) return;
  capture(`stop-${reason}`);
  cleanup?.(); cleanup = undefined;
  stoppedAt = new Date().toISOString();
  publish({ recording: false, hasRecording: true, stopReason: reason });
}

export function clearLayoutDiagnostics() {
  stopLayoutDiagnostics();
  samples = []; environment = null; startedAt = null; stoppedAt = null; droppedSamples = 0; lastGeometry = '';
  publish({ recording: false, hasRecording: false });
}

export function exportLayoutDiagnostics() {
  // Omit unchanged fields so a short rotation report can be pasted into a conversation.
  let previous: Record<string, unknown> = {};
  const encoded = samples.map(sample => {
    const changed = Object.fromEntries(Object.entries(sample).filter(([key, value]) =>
      key === 'at' || key === 'reason' || JSON.stringify(value) !== JSON.stringify(previous[key])));
    previous = sample;
    return JSON.stringify(changed);
  });
  const metadata = { format: 'arc-layout-diagnostics', version: 1, startedAt, stoppedAt,
    recording: status.recording, stopReason: status.stopReason ?? null, environment, limits, droppedSamples,
    sampleEncoding: 'First sample is complete. Later samples inherit omitted top-level fields from the previous sample.' };
  return `${JSON.stringify(metadata).slice(0, -1)},"samples":[\n${encoded.join(',\n')}\n]}`;
}
