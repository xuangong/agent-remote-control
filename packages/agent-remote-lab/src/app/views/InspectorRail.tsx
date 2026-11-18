// The Replica Inspector rail.
import { ReplicaInspector } from '../../components/ReplicaInspector.js';
import { SupportingRail } from '../../components/SupportingRail.js';
import type { AppScope } from '../types.js';

export function InspectorRail({ scope }: { readonly scope: Pick<AppScope, 'closeInspector' | 'compactLayout' | 'inspectorOpen' | 'providerName' | 'state' | 'status' | 'viewTriggerRef' | 'windowMode'> }) {
  const { closeInspector, compactLayout, inspectorOpen, providerName, state, status, viewTriggerRef, windowMode } = scope;
  return <>
    <SupportingRail
      id="lab-inspector"
      label="Replica Inspector"
      className="lab-inspector-rail"
      collapsible
      compact={compactLayout}
      open={windowMode && inspectorOpen}
      triggerRef={viewTriggerRef}
      onClose={() => closeInspector()}
    >
      <div className="lab-rail-heading">
        <p className="lab-eyebrow">Replica Inspector</p>
        <span>Public replica state</span>
      </div>
      <ReplicaInspector state={state} sessionStatus={status} providerName={providerName} />
    </SupportingRail>
  </>;
}
