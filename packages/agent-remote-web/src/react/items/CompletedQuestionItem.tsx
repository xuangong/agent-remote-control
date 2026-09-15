import { useId } from 'react';
import { useItemDisclosure } from '../TimelineDisplay.js';
import { ContentPreview } from './ContentPreview.js';
import type { AgentInteractionRequest, AgentInteractionResponse } from '@borgee/agent-remote-protocol';

import { MarkdownContent } from '../MarkdownContent.js';

interface CompletedQuestionItemProps {
  readonly request: Extract<AgentInteractionRequest, { kind: 'question' }>;
  readonly response: Extract<AgentInteractionResponse, { kind: 'question' }>;
}

export function CompletedQuestionItem({ request, response }: CompletedQuestionItemProps) {
  const { expanded: showQuestions, preview, toggle } = useItemDisclosure();
  const answersId = useId();
  const rows = request.questions.map((question) => {
    const answer = response.answers.find(({ questionId }) => questionId === question.questionId);
    return { question, answer, answered: Boolean(answer?.redacted || answer?.selectedValues.length || answer?.customText) };
  });
  const answeredCount = rows.filter(({ answered }) => answered).length;
  const status = response.dismissed ? 'Dismissed' : answeredCount === rows.length ? 'Answered' : answeredCount ? 'Partially answered' : 'No answers';
  const count = !response.dismissed && answeredCount < rows.length
    ? `${answeredCount} of ${rows.length} answered`
    : `${rows.length} ${rows.length === 1 ? 'question' : 'questions'}`;

  return <article className="agent-item agent-interaction-completed agent-question-completed">
    <header className="agent-question-receipt-header">
      <div className="agent-question-receipt-summary">
        <svg className="agent-question-receipt-icon" data-answered={!response.dismissed && answeredCount === rows.length} width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 3.5H2.5V14H13.5V3.5H12M5.5 2H10.5V5H5.5V2Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <path d={!response.dismissed && answeredCount === rows.length ? 'M5 9L7 11L11 7' : 'M5 9H11'} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="agent-question-receipt-status">{status}</span>
        <span className="agent-question-receipt-count">{count}</span>
      </div>
      <button className="agent-question-context-toggle" type="button" aria-expanded={showQuestions} aria-controls={answersId} onClick={toggle}>
        {showQuestions ? 'Hide questions' : 'Show questions'}
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d={showQuestions ? 'M3 7.5L6 4.5L9 7.5' : 'M3 4.5L6 7.5L9 4.5'} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
    </header>
    <dl id={answersId} className="agent-question-receipt-answers">
      {rows.map(({ question, answer, answered }) => <div className="agent-completed-answer" key={question.questionId}>
        <dt>{question.header}</dt>
        <dd>
          {preview ? <ContentPreview text={question.prompt} /> : null}
          {answered && (question.sensitive || answer?.redacted) ? <span className="agent-answer-hidden">Hidden answer</span> : null}
          {!question.sensitive && !answer?.redacted && answer?.selectedValues.length ? <ul>{answer.selectedValues.map((value) => <li key={value}>{question.options.find((option) => option.value === value)?.label ?? value}</li>)}</ul> : null}
          {!question.sensitive && !answer?.redacted && answer?.customText ? <p className="agent-answer-custom">{answer.customText}</p> : null}
          {!answered ? <span className="agent-answer-empty">{response.dismissed ? 'Dismissed' : 'No answer provided'}</span> : null}
          <div className="agent-completed-question-context" hidden={!showQuestions}>
            <MarkdownContent markdown={question.prompt} />
            {question.description ? <MarkdownContent markdown={question.description} className="agent-completed-question-description" /> : null}
          </div>
        </dd>
      </div>)}
    </dl>
  </article>;
}
