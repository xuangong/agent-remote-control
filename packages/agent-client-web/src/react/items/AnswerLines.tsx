import { useTranslate } from '../locale.js';
import { MarkdownContent } from '../MarkdownContent.js';
import type { AskLine } from '../TaskDirectory.js';

/**
 * What the person asked a bot from this conversation, and its answer: one quiet line per ask that opens to both. The question
 * never reached this conversation's session, so the line is the only trace of it here.
 */
export function AnswerLines({ lines }: { readonly lines: readonly AskLine[] }) {
  const t = useTranslate();
  if (!lines.length) return null;
  return <div className="agent-timeline-item agent-task-inputs" data-answer-lines="">
    {lines.map(line => <details key={line.id} className="agent-assistant-messages" data-ask-id={line.id} data-answered={line.answer ? '' : undefined}>
      <summary>{t(line.answer ? 'timeline.botAnswered' : 'timeline.botAnswering', { bot: line.bot })}</summary>
      <p className="agent-ask-question"><strong>{t('timeline.botAsked')}</strong> {line.text}</p>
      {line.answer ? <MarkdownContent markdown={line.answer.text} /> : null}
    </details>)}
  </div>;
}
