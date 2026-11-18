// The trigger refs and focus-return targets of every view control.
import { useRef, useState } from 'react';
import { isCompactLayout } from './helpers.js';

export function useViewTargets() {

  const workbenchTabRef = useRef<HTMLButtonElement>(null);

  const traceTabRef = useRef<HTMLButtonElement>(null);

  const sessionsTriggerRef = useRef<HTMLButtonElement>(null);

  const [trackedOnly, setTrackedOnly] = useState(false);

  const viewTriggerRef = useRef<HTMLButtonElement>(null);

  const [headerViewTarget, setHeaderViewTarget] = useState<HTMLDivElement | null>(null);

  const [sidebarViewTarget, setSidebarViewTarget] = useState<HTMLDivElement | null>(null);

  const [minimizedViewTarget, setMinimizedViewTarget] = useState<HTMLDivElement | null>(null);

  const [sessionViewTarget, setSessionViewTarget] = useState<HTMLDivElement | null>(null);

  const [windowToolbarViewTarget, setWindowToolbarViewTarget] = useState<HTMLDivElement | null>(null);

  const [mobileViewTarget, setMobileViewTarget] = useState<HTMLDivElement | null>(null);

  const [traceViewTarget, setTraceViewTarget] = useState<HTMLDivElement | null>(null);

  const [pageViewTarget, setPageViewTarget] = useState<HTMLDivElement | null>(null);

  /** The desktop page toolbar's trailing slot, where a page such as Hosts places its actions. */
  const [pageActionsTarget, setPageActionsTarget] = useState<HTMLDivElement | null>(null);

  const connectionSummaryRef = useRef<HTMLDetailsElement>(null);

  const workbenchPanelRef = useRef<HTMLElement>(null);

  const compactLayoutRef = useRef(isCompactLayout());

  const focusTimelineAfterAttachRef = useRef(false);
  return { workbenchTabRef, traceTabRef, sessionsTriggerRef, trackedOnly, setTrackedOnly, viewTriggerRef, headerViewTarget, setHeaderViewTarget, sidebarViewTarget, setSidebarViewTarget, minimizedViewTarget, setMinimizedViewTarget, sessionViewTarget, setSessionViewTarget, windowToolbarViewTarget, setWindowToolbarViewTarget, mobileViewTarget, setMobileViewTarget, traceViewTarget, setTraceViewTarget, pageViewTarget, setPageViewTarget, pageActionsTarget, setPageActionsTarget, connectionSummaryRef, workbenchPanelRef, compactLayoutRef, focusTimelineAfterAttachRef };
}

export type ViewTargetsSlice = ReturnType<typeof useViewTargets>;
