import type { ReactNode } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { AssistantWhere } from './details-host.js';

/** Where the assistant works: its agent (with the agents before a handoff), its machine with whether it is online, and its sessions. */
export function WhereItWorks({ where, sessions }: { where?: AssistantWhere; sessions?: ReactNode }) {
  const t = useTranslate();
  return <div className="lab-assistant-group">
    {where ? <>
      <div className="lab-assistant-row"><span>{t('details.agent')}</span>
        <span className="lab-assistant-value">{where.provider}{where.earlier.length ? <small>{t('details.earlier', { agents: where.earlier.join(' → ') })}</small> : null}</span></div>
      <div className="lab-assistant-row"><span>{t('details.machine')}</span>
        <span className="lab-assistant-value" data-online={where.online}>{where.online !== undefined ? <i className="lab-assistant-online" aria-hidden="true" /> : null}{where.host}
          {where.online === false ? <small>{t('details.offline')}</small> : null}</span></div>
    </> : null}
    {sessions ? <div className="lab-assistant-row lab-assistant-row-sessions"><span>{t('details.sessions')}</span>{sessions}</div> : null}
  </div>;
}
