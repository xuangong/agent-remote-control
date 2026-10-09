import type { AgentUsage } from '@orchardworks/agent-remote-protocol';

interface Props {
  usage?: AgentUsage;
  lastKnown: boolean;
}

const compactCount = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const fullCount = new Intl.NumberFormat('en-US');
const percentage = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });

export function AgentSessionUsage({ usage, lastKnown }: Props) {
  const tokenLabel = usage?.tokenScope === 'session' ? 'Session tokens'
    : usage?.tokenScope === 'turn' ? 'Latest turn tokens'
      : usage?.tokenScope === 'call' ? 'Latest call tokens' : 'Token usage';
  const used = usage?.contextScope === 'current' ? usage.contextWindowUsedTokens : undefined;
  const capacity = usage?.contextScope === 'current' ? usage.contextWindowMaxTokens : undefined;
  const proportion = used !== undefined && capacity !== undefined && capacity > 0 ? used / capacity : undefined;
  const stale = lastKnown && usage !== undefined ? <span className="agent-session-usage-stale">Last known</span> : null;

  return <div className="agent-session-usage">
    <section aria-label={tokenLabel}>
      <h3>{tokenLabel}{stale}</h3>
      {usage?.tokenScope ? <dl className="agent-session-facts">
        <dt>Input</dt><dd><TokenCount value={usage.inputTokens} /></dd>
        <dt>Output</dt><dd><TokenCount value={usage.outputTokens} /></dd>
        <dt>Cache read</dt><dd><TokenCount value={usage.cachedInputTokens} /></dd>
        <dt>Cache write</dt><dd><TokenCount value={usage.cacheCreationInputTokens} /></dd>
        <dt>Total</dt><dd><TokenCount value={usage.totalTokens} /></dd>
      </dl> : <p className="agent-session-usage-empty">Not provided</p>}
    </section>
    <section aria-label="Current context">
      <h3>Current context{stale}</h3>
      <dl className="agent-session-facts">
        <dt>Used</dt><dd><TokenCount value={used} /></dd>
        <dt>Capacity</dt><dd><TokenCount value={capacity} /></dd>
        <dt>Utilization</dt><dd>{proportion === undefined ? 'Not provided' : percentage.format(proportion)}</dd>
      </dl>
    </section>
  </div>;
}

function TokenCount({ value }: { value?: number }) {
  if (value === undefined) return <>Not provided</>;
  const full = `${fullCount.format(value)} tokens`;
  return <data value={value} title={full}>
    <span aria-hidden="true">{compactCount.format(value)}</span>
    <span className="agent-visually-hidden">{full}</span>
  </data>;
}
