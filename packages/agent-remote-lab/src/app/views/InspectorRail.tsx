// The Replica Inspector rail.
import { Suspense } from 'react';
import { LazyReplicaInspector as ReplicaInspector, useEverShown } from '../lazy-screens.js';
import { SupportingRail } from '../../features/windows/SupportingRail.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { AppScope } from '../types.js';

export function InspectorRail({ scope }: { readonly scope: Pick<AppScope, 'closeInspector' | 'compactLayout' | 'inspectorOpen' | 'providerName' | 'state' | 'status' | 'viewTriggerRef' | 'windowMode'> }) {
  const { closeInspector, compactLayout, inspectorOpen, providerName, state, status, viewTriggerRef, windowMode } = scope;
  const t = useTranslate();
  const opened = useEverShown(windowMode && inspectorOpen);
  return <>
    <SupportingRail
      id="lab-inspector"
      label={t('diagnostics.inspector.title')}
      className="lab-inspector-rail"
      collapsible
      compact={compactLayout}
      open={windowMode && inspectorOpen}
      triggerRef={viewTriggerRef}
      onClose={() => closeInspector()}
    >
      <div className="lab-rail-heading">
        <p className="lab-eyebrow">{t('diagnostics.inspector.title')}</p>
        <span>{t('diagnostics.inspector.subtitle')}</span>
      </div>
      {opened ? <Suspense fallback={null}><ReplicaInspector state={state} sessionStatus={status} providerName={providerName} /></Suspense> : null}
    </SupportingRail>
  </>;
}
