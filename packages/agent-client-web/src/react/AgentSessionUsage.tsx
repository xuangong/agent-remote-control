import type { AgentUsage } from '@orchardworks/agent-remote-protocol';
import { useTranslate } from './locale.js';

interface Props {
  usage?: AgentUsage;
  lastKnown: boolean;
}

const compactCount = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const fullCount = new Intl.NumberFormat('en-US');
const percentage = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });

export function AgentSessionUsage({ usage, lastKnown }: Props) {
  const t = useTranslate();
  const tokenLabel = usage?.tokenScope === 'session' ? t('composer.usage.session')
    : usage?.tokenScope === 'runtime' ? t('composer.usage.runtime')
      : usage?.tokenScope === 'turn' ? t('composer.usage.turn')
        : usage?.tokenScope === 'call' ? t('composer.usage.call') : t('composer.usage.tokens');
  const tokenDescription = usage?.tokenScope === 'session' ? t('composer.usage.sessionHint')
    : usage?.tokenScope === 'runtime' ? t('composer.usage.runtimeHint') : undefined;
  const used = usage?.contextScope === 'current' ? usage.contextWindowUsedTokens : undefined;
  const capacity = usage?.contextScope === 'current' ? usage.contextWindowMaxTokens : undefined;
  const proportion = used !== undefined && capacity !== undefined && capacity > 0 ? used / capacity : undefined;
  const stale = lastKnown && usage !== undefined ? <span className="agent-session-usage-stale">{t('composer.usage.lastKnown')}</span> : null;

  return <div className="agent-session-usage">
    <section aria-label={tokenLabel}>
      <h3>{tokenLabel}{stale}</h3>
      {tokenDescription ? <p className="agent-session-usage-description">{tokenDescription}</p> : null}
      {usage?.tokenScope ? <dl className="agent-session-facts">
        <dt>{t('composer.usage.input')}</dt><dd><TokenCount value={usage.inputTokens} /></dd>
        <dt>{t('composer.usage.output')}</dt><dd><TokenCount value={usage.outputTokens} /></dd>
        <dt>{t('composer.usage.cacheRead')}</dt><dd><TokenCount value={usage.cachedInputTokens} /></dd>
        <dt>{t('composer.usage.cacheWrite')}</dt><dd><TokenCount value={usage.cacheCreationInputTokens} /></dd>
        <dt>{t('composer.usage.total')}</dt><dd><TokenCount value={usage.totalTokens} /></dd>
      </dl> : <p className="agent-session-usage-empty">{t('composer.usage.notProvided')}</p>}
    </section>
    <section aria-label={t('composer.usage.context')}>
      <h3>{t('composer.usage.context')}{stale}</h3>
      <dl className="agent-session-facts">
        <dt>{t('composer.usage.used')}</dt><dd><TokenCount value={used} /></dd>
        <dt>{t('composer.usage.capacity')}</dt><dd><TokenCount value={capacity} /></dd>
        <dt>{t('composer.usage.utilization')}</dt><dd>{proportion === undefined ? t('composer.usage.notProvided') : percentage.format(proportion)}</dd>
      </dl>
    </section>
  </div>;
}

function TokenCount({ value }: { value?: number }) {
  const t = useTranslate();
  if (value === undefined) return <>{t('composer.usage.notProvided')}</>;
  const full = t('composer.usage.tokenCount', { count: value, tokens: fullCount.format(value) });
  return <data value={value} title={full}>
    <span aria-hidden="true">{compactCount.format(value)}</span>
    <span className="agent-visually-hidden">{full}</span>
  </data>;
}
