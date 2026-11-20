// The View options control, placed in the view target that currently shows.
import { ViewOptions } from '../../components/ViewOptions.js';
import type { AppScope } from '../types.js';

export function GlobalViewOptions({ scope }: { readonly scope: Pick<AppScope, 'activeView' | 'askView' | 'attention' | 'compactLayout' | 'contextVisible' | 'desktopContextVisible' | 'dispatchPanels' | 'headerHidden' | 'headerViewTarget' | 'inspectorOpen' | 'minimizedViewTarget' | 'mobileViewTarget' | 'pageOpen' | 'pageViewTarget' | 'sessionViewTarget' | 'setAllPanelsVisible' | 'sidebarViewTarget' | 'supportingRailOpen' | 'teamView' | 'toggleContext' | 'tpmView' | 'traceViewTarget' | 'userScoped' | 'viewTriggerRef' | 'windowMode' | 'windowToolbarShown' | 'windowToolbarViewTarget' | 'windowView'> }) {
  const { activeView, askView, attention, compactLayout, contextVisible, desktopContextVisible, dispatchPanels, headerHidden, headerViewTarget, inspectorOpen, minimizedViewTarget, mobileViewTarget, pageOpen, pageViewTarget, sessionViewTarget, setAllPanelsVisible, sidebarViewTarget, supportingRailOpen, teamView, toggleContext, tpmView, traceViewTarget, userScoped, viewTriggerRef, windowMode, windowToolbarShown, windowToolbarViewTarget, windowView } = scope;
  return <>
    <ViewOptions attentionControls={<>
      {askView.controls}
      {windowView.controls}{userScoped ? attention.controls : null}{tpmView.controls}{teamView.controls}
    </>} target={!headerHidden ? headerViewTarget : compactLayout ? mobileViewTarget
      // A desktop Window keeps View options in one place, the start of its toolbar (as Bot mode's toolbar keeps its sidebar
      // control), whether or not the sidebar shows, rather than in the sidebar or the first pane heading.
      : windowToolbarShown && !pageOpen && activeView === 'workbench' ? windowToolbarViewTarget
      : desktopContextVisible && sidebarViewTarget ? sidebarViewTarget : pageOpen ? pageViewTarget : activeView === 'trace' ? traceViewTarget
      : windowToolbarShown ? windowToolbarViewTarget : minimizedViewTarget ?? sessionViewTarget}
      triggerRef={viewTriggerRef} headerVisible={!headerHidden} sidebarVisible={contextVisible}
      inspectorVisible={inspectorOpen} compact={compactLayout} inert={!windowMode || supportingRailOpen}
      onSetAllVisible={setAllPanelsVisible} onToggleHeader={() => dispatchPanels({ type: 'header.toggle' })} onToggleSidebar={toggleContext}
      onToggleInspector={() => dispatchPanels({ type: 'inspector.toggle' })} />
  </>;
}
