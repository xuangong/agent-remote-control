import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { AssistantWhere } from './details-host.js';

/** Where the assistant works: its agent (with the agents before a handoff) and its machine, with whether it is online. */
export function WhereItWorks({ where }: { where: AssistantWhere }) {
  const t = useTranslate();
  return <div className="lab-assistant-group">
    <div className="lab-assistant-row"><span>{t('details.agent')}</span>
      <span className="lab-assistant-value">{where.provider}{where.earlier.length ? <small>{t('details.earlier', { agents: where.earlier.join(' → ') })}</small> : null}</span></div>
    <div className="lab-assistant-row"><span>{t('details.machine')}</span>
      <span className="lab-assistant-value" data-online={where.online}>{where.online !== undefined ? <i className="lab-assistant-online" aria-hidden="true" /> : null}{where.host}
        {where.online === false ? <small>{t('details.offline')}</small> : null}</span></div>
  </div>;
}
