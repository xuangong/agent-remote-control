import { useEffect, useState } from 'react';
import { BOT_MISSION_LIMIT } from '@orchardworks/agent-remote-protocol';
import { useTranslate } from '@orchardworks/agent-client-web/react';

/** A bot's mission as the person writes it; saving an empty text clears it. */
export interface MissionChoice { readonly text: string; save(text: string): void }

export function MissionEditor({ mission }: { mission: MissionChoice }) {
  const t = useTranslate();
  const [draft, setDraft] = useState(mission.text);
  useEffect(() => { setDraft(mission.text); }, [mission.text]);
  return <div className="lab-assistant-process">
    <textarea aria-label={t('details.mission')} value={draft} maxLength={BOT_MISSION_LIMIT} rows={4} onChange={event => setDraft(event.target.value)} />
    <p className="lab-assistant-hint">{t('details.missionHint')}</p>
    <button type="button" className="lab-assistant-action" disabled={draft.trim() === mission.text} onClick={() => mission.save(draft.trim())}>{t('details.missionSave')}</button>
  </div>;
}
