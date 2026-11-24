import { useEffect, useState } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';

/** Who manages a standing bot, and the chiefs the person may move it to: themselves, or another standing bot. */
export interface ChiefChoice {
  readonly current?: { readonly botId: string; readonly name: string };
  readonly choices: readonly { readonly botId: string; readonly name: string }[];
  move(chief: string | null): Promise<void> | void;
}
const PERSON = '';

export function ChiefPicker({ chief }: { chief: ChiefChoice }) {
  const t = useTranslate();
  const [value, setValue] = useState(chief.current?.botId ?? PERSON);
  useEffect(() => { setValue(chief.current?.botId ?? PERSON); }, [chief.current?.botId]);
  return <div className="lab-assistant-process">
    <select aria-label={t('details.chief')} value={value} onChange={event => setValue(event.target.value)}>
      <option value={PERSON}>{t('details.chiefPerson')}</option>
      {chief.choices.map(choice => <option key={choice.botId} value={choice.botId}>{choice.name}</option>)}
    </select>
    <p className="lab-assistant-hint">{t('details.chiefHint')}</p>
    <button type="button" className="lab-assistant-action" disabled={value === (chief.current?.botId ?? PERSON)} onClick={() => void chief.move(value === PERSON ? null : value)}>{t('details.chiefSave')}</button>
  </div>;
}
