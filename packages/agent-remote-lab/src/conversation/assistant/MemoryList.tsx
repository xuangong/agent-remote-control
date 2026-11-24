import { useState } from 'react';
import { BOT_FACT_LIMIT, BOT_MEMORY_FACTS, type BotFact } from '@orchardworks/agent-remote-protocol';
import { useTranslate } from '@orchardworks/agent-client-web/react';

/** A bot's memory as the person keeps it: the facts, which they add, change or delete beside the bot's own. */
export interface MemoryChoice { readonly facts: readonly BotFact[]; save(facts: readonly BotFact[]): void }

export function MemoryList({ memory }: { memory: MemoryChoice }) {
  const t = useTranslate();
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const [adding, setAdding] = useState('');
  const add = () => {
    const text = adding.trim();
    if (!text || memory.facts.length >= BOT_MEMORY_FACTS) return;
    memory.save([...memory.facts, { id: `f${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`, text }]);
    setAdding('');
  };
  const change = (id: string, text: string | undefined) => {
    memory.save(memory.facts.flatMap(fact => fact.id !== id ? [fact] : text === undefined ? [] : [{ id, text }]));
    setEditing(undefined);
  };
  return <div className="lab-assistant-process">
    {memory.facts.length ? <ul className="lab-assistant-memory">{memory.facts.map(fact => <li key={fact.id}>
      {editing?.id === fact.id ? <>
        <input aria-label={t('details.memoryFact')} value={editing.text} maxLength={BOT_FACT_LIMIT} onChange={event => setEditing({ id: fact.id, text: event.target.value })} />
        <span className="lab-assistant-task-actions">
          <button type="button" className="lab-assistant-action" disabled={!editing.text.trim() || editing.text.trim() === fact.text} onClick={() => change(fact.id, editing.text.trim())}>{t('details.memorySave')}</button>
          <button type="button" className="lab-assistant-action" onClick={() => setEditing(undefined)}>{t('details.memoryCancel')}</button>
        </span>
      </> : <>
        <span>{fact.text}</span>
        <span className="lab-assistant-task-actions">
          <button type="button" className="lab-assistant-action" aria-label={t('details.memoryEdit')} onClick={() => setEditing({ id: fact.id, text: fact.text })}>{t('details.memoryEdit')}</button>
          <button type="button" className="lab-assistant-action" aria-label={t('details.memoryDelete')} onClick={() => change(fact.id, undefined)}>{t('details.memoryDelete')}</button>
        </span>
      </>}
    </li>)}</ul> : <p className="lab-assistant-empty">{t('details.memoryEmpty')}</p>}
    {memory.facts.length < BOT_MEMORY_FACTS ? <form className="lab-assistant-memory-add" onSubmit={event => { event.preventDefault(); add(); }}>
      <input aria-label={t('details.memoryNew')} placeholder={t('details.memoryNew')} value={adding} maxLength={BOT_FACT_LIMIT} onChange={event => setAdding(event.target.value)} />
      <button type="submit" className="lab-assistant-action" disabled={!adding.trim()}>{t('details.memoryAdd')}</button>
    </form> : null}
    <p className="lab-assistant-hint">{t('details.memoryHint')}</p>
  </div>;
}
