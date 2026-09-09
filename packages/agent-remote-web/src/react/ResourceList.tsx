import { useState } from 'react';
import type { ResourceBinding } from '@borgee/agent-remote-protocol';

import type { AgentReplicaState } from '../replica/types.js';
import { ResourceCard } from './ResourceCard.js';

export interface ResourceListProps {
  readonly bindings: readonly ResourceBinding[];
  readonly resources: AgentReplicaState['resources'];
  readonly onRequest?: (binding: ResourceBinding) => Promise<void>;
}

export function ResourceList({ bindings, resources, onRequest }: ResourceListProps) {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});

  async function request(binding: ResourceBinding): Promise<void> {
    if (!onRequest || pending.has(binding.resourceId)) return;
    setPending((current) => new Set(current).add(binding.resourceId));
    setFailures((current) => {
      const { [binding.resourceId]: _previous, ...remaining } = current;
      return remaining;
    });
    try {
      await onRequest(binding);
    } catch (error) {
      setFailures((current) => ({
        ...current,
        [binding.resourceId]: error instanceof Error && error.message ? error.message : 'Resource request failed.',
      }));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(binding.resourceId);
        return next;
      });
    }
  }

  if (bindings.length === 0) return null;
  return <section className="agent-resources" aria-label="Referenced resources">
    <h4>Resources</h4>
    <ul>{bindings.map((binding) => <ResourceCard
      key={`${binding.resourceId}-${binding.locator}`}
      binding={binding}
      detail={resources[binding.resourceId]}
      pending={pending.has(binding.resourceId)}
      failure={failures[binding.resourceId]}
      onRequest={onRequest ? async () => request(binding) : undefined}
    />)}</ul>
  </section>;
}
