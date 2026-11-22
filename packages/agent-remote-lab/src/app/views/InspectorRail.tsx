// The Replica Inspector rail.
import { ReplicaInspector } from '../../features/diagnostics/ReplicaInspector.js';
import { SupportingRail } from '../../features/windows/SupportingRail.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { AppScope } from '../types.js';

export function InspectorRail({ scope }: { readonly scope: Pick<AppScope, 'closeInspector' | 'compactLayout' | 'inspectorOpen' | 'providerName' | 'state' | 'status' | 'viewTriggerRef' | 'windowMode'> }) {
  const { closeInspector, compactLayout, inspectorOpen, providerName, state, status, viewTriggerRef, windowMode } = scope;
  const t = useTranslate();
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
      <ReplicaInspector state={state} sessionStatus={status} providerName={providerName} />
    </SupportingRail>
  </>;
}
