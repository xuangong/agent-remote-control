import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslate } from '../locale.js';
import type { AgentInteractionRequest, AgentInteractionResponse } from '@orchardworks/agent-remote-protocol';

export interface QuestionAnswerDraft {
  readonly selectedValues: readonly string[];
  readonly customText?: string;
}

export interface QuestionDraft {
  readonly answers: Readonly<Record<string, QuestionAnswerDraft>>;
  readonly activeQuestionId?: string;
}

export interface QuestionCardProps {
  readonly request: Extract<AgentInteractionRequest, { kind: 'question' }>;
  readonly onResponse: (response: Extract<AgentInteractionResponse, { kind: 'question' }>) => Promise<void>;
  readonly pending: boolean;
  readonly readOnly?: boolean;
  readonly failure?: string;
  readonly draft?: QuestionDraft;
  readonly onDraftChange?: (draft: QuestionDraft) => void;
}

export function QuestionCard({ request, onResponse, pending, failure, readOnly = false, draft: controlledDraft, onDraftChange }: QuestionCardProps) {
  const t = useTranslate();
  // The card renders from its own draft, which a typed character changes within the event itself. An owner that hands the draft
  // back later (after a render of its own, or a store that publishes) would otherwise show the old text for a render, and the
  // browser drops the input method's composition when a field's value is written while it composes.
  const [draft, setLocalDraft] = useState<QuestionDraft>(controlledDraft ?? { answers: {} });
  const [offered, setOffered] = useState(controlledDraft);
  const reported = useRef(new WeakSet<QuestionDraft>());
  // A draft the owner offers that this card did not report (another device's answer, a reset) replaces the card's own.
  if (controlledDraft !== offered) {
    setOffered(controlledDraft);
    if (!controlledDraft || !reported.current.has(controlledDraft)) setLocalDraft(controlledDraft ?? { answers: {} });
  }
  const [error, setError] = useState<string>();
  const tabsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(0, request.questions.findIndex(({ questionId }) => questionId === draft.activeQuestionId));

  function update(next: QuestionDraft): void {
    reported.current.add(next);
    setLocalDraft(next);
    onDraftChange?.(next);
    setError(undefined);
  }

  function navigate(index: number): void {
    const question = request.questions[index];
    if (!question || pending) return;
    update({ ...draft, activeQuestionId: question.questionId });
    tabsRef.current[index]?.focus();
  }

  function changeAnswer(questionId: string, answer: QuestionAnswerDraft, advance = false): void {
    const index = request.questions.findIndex((question) => question.questionId === questionId);
    const nextQuestion = advance ? request.questions[index + 1] : undefined;
    update({
      ...draft,
      answers: { ...draft.answers, [questionId]: answer },
      ...(nextQuestion ? { activeQuestionId: nextQuestion.questionId } : {}),
    });
    if (nextQuestion) tabsRef.current[index + 1]?.focus();
  }

  function navigateByKey(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let next: number | undefined;
    if (event.key === 'ArrowRight') next = (index + 1) % request.questions.length;
    if (event.key === 'ArrowLeft') next = (index + request.questions.length - 1) % request.questions.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = request.questions.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    navigate(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || readOnly) return;
    const missing = request.questions.findIndex((question) => question.required && !isAnswered(draft.answers[question.questionId]));
    if (missing >= 0) {
      navigate(missing);
      setError(t('timeline.question.requiresAnswer', { header: request.questions[missing]!.header }));
      return;
    }
    setError(undefined);
    const answers = request.questions.map(({ questionId, sensitive }) => {
      const answer = draft.answers[questionId];
      const customText = sensitive ? answer?.customText : answer?.customText?.trim();
      return { questionId, selectedValues: [...(answer?.selectedValues ?? [])], ...(customText ? { customText } : {}) };
    });
    await onResponse({ kind: 'question', answers });
  }

  return <form className="agent-interaction agent-question" onSubmit={submit} aria-busy={pending}>
    <header><span className="agent-item-kicker">{t('timeline.question.kicker')}</span><h3>{t('timeline.question.heading')}</h3></header>
    <div hidden={readOnly} className="agent-question-tabs" role="tablist" aria-label={t('timeline.question.tabs')}>
      {request.questions.map((question, index) => <button
        key={question.questionId}
        ref={(element) => { tabsRef.current[index] = element; }}
        id={`${request.requestId}-${question.questionId}-tab`}
        type="button"
        role="tab"
        aria-controls={`${request.requestId}-${question.questionId}-panel`}
        aria-selected={activeIndex === index}
        aria-label={t(isAnswered(draft.answers[question.questionId]) ? 'timeline.question.tabAnswered' : 'timeline.question.tab', { position: index + 1, header: question.header })}
        data-answered={isAnswered(draft.answers[question.questionId])}
        tabIndex={activeIndex === index ? 0 : -1}
        disabled={pending}
        onClick={() => navigate(index)}
        onKeyDown={(event) => navigateByKey(event, index)}
      ><span>{index + 1}. {question.header}</span>{isAnswered(draft.answers[question.questionId]) ? <span aria-hidden="true"> ✓</span> : null}</button>)}
    </div>
    {request.questions.map((question, index) => {
      const answer = draft.answers[question.questionId] ?? { selectedValues: [] };
      return <fieldset
        key={question.questionId}
        id={`${request.requestId}-${question.questionId}-panel`}
        role="tabpanel"
        aria-labelledby={`${request.requestId}-${question.questionId}-tab`}
        hidden={!readOnly && activeIndex !== index}
        disabled={pending || readOnly}
      >
        <legend>{question.header}</legend>
        <p>{question.prompt}</p>
        {question.description ? <small>{question.description}</small> : null}
        <div className="agent-question-options">
          {question.options.map((option) => <label key={option.value}>
            <input
              type={question.selection === 'single' ? 'radio' : 'checkbox'}
              name={`${question.questionId}-selected`}
              value={option.value}
              checked={answer.selectedValues.includes(option.value)}
              onChange={(event) => changeAnswer(question.questionId, {
                ...answer,
                selectedValues: question.selection === 'single' ? [option.value]
                  : event.target.checked ? [...answer.selectedValues, option.value]
                  : answer.selectedValues.filter((value) => value !== option.value),
              }, question.selection === 'single')}
            />
            <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
          </label>)}
          {question.allowCustomText ? <label className="agent-question-custom">
            <span>{t('timeline.question.custom')}</span>
            <input name={`${question.questionId}-custom`} type={question.sensitive ? 'password' : 'text'} autoComplete={question.sensitive ? 'off' : undefined} value={answer.customText ?? ''} onChange={(event) => changeAnswer(question.questionId, { ...answer, customText: event.target.value })} />
          </label> : null}
        </div>
      </fieldset>;
    })}
    {error ?? failure ? <p className="agent-form-error" role="alert">{error ?? failure}</p> : null}
    <div hidden={readOnly} className="agent-interaction-actions">
      {activeIndex > 0 ? <button type="button" disabled={pending} onClick={() => navigate(activeIndex - 1)}>{t('common.previous')}</button> : null}
      {activeIndex < request.questions.length - 1 ? <button type="button" disabled={pending} onClick={() => navigate(activeIndex + 1)}>{t('common.next')}</button> : null}
      <button type="submit" disabled={pending}>{pending ? t('timeline.interaction.submitting') : t('timeline.question.submit')}</button>
      {request.questions.every(({ allowDismiss }) => allowDismiss) ? <button
        type="button"
        disabled={pending}
        onClick={async () => { await onResponse({ kind: 'question', answers: [], dismissed: true }); }}
      >{t('common.dismiss')}</button> : null}
    </div>
  </form>;
}

function isAnswered(answer: QuestionAnswerDraft | undefined): boolean {
  return (answer?.selectedValues.length ?? 0) > 0 || Boolean(answer?.customText?.trim());
}
