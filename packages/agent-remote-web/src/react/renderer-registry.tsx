import { Component, type ReactNode } from 'react';
import type { AgentTimelineItem } from '@borgee/agent-remote-protocol';

export type TimelineDetailRenderer = (item: AgentTimelineItem) => ReactNode;

interface RegisteredRenderer {
  readonly renderer: TimelineDetailRenderer;
  readonly revision: number;
}

export class RendererRegistry {
  private readonly renderers = new Map<AgentTimelineItem['type'], RegisteredRenderer>();
  private nextRendererRevision = 0;

  register(type: AgentTimelineItem['type'], renderer: TimelineDetailRenderer): () => void {
    this.renderers.set(type, { renderer, revision: ++this.nextRendererRevision });
    return () => {
      if (this.renderers.get(type)?.renderer === renderer) this.renderers.delete(type);
    };
  }

  render(item: AgentTimelineItem): ReactNode {
    const registered = this.renderers.get(item.type);
    if (!registered) return null;
    return <ExtensionErrorBoundary item={item} rendererRevision={registered.revision}>
      <RendererOutput item={item} renderer={registered.renderer} />
    </ExtensionErrorBoundary>;
  }
}

function RendererOutput({ item, renderer }: {
  readonly item: AgentTimelineItem;
  readonly renderer: TimelineDetailRenderer;
}) {
  return renderer(item);
}

interface ExtensionErrorBoundaryProps {
  readonly children: ReactNode;
  readonly item: AgentTimelineItem;
  readonly rendererRevision: number;
}

class ExtensionErrorBoundary extends Component<ExtensionErrorBoundaryProps, { readonly failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  componentDidUpdate(previous: ExtensionErrorBoundaryProps): void {
    if (
      this.state.failed
      && (
        previous.rendererRevision !== this.props.rendererRevision
        || !sameSemanticValue(previous.item, this.props.item)
      )
    ) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <span className="agent-extension-error" role="status">Detail renderer unavailable</span>;
    }
    return this.props.children;
  }
}

function sameSemanticValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameSemanticValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => (
      Object.prototype.hasOwnProperty.call(rightRecord, key)
      && sameSemanticValue(leftRecord[key], rightRecord[key])
    ));
}
