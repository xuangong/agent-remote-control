import type { AgentQuestion, AgentInteractionRequest, AgentInteractionResponse } from '@orchardworks/agent-provider-sdk';
import { isRecord, readString } from './native.js';

export function mapCodexQuestion(value: unknown, index: number): AgentQuestion {
    if (!isRecord(value)) throw new Error(`Codex question ${index + 1} is invalid`);
    const questionId = readString(value.id);
    const header = readString(value.header);
    const prompt = readString(value.question);
    if (!questionId || !header || !prompt) {
      throw new Error(`Codex question ${index + 1} is missing id, header, or prompt`);
    }
    const options = Array.isArray(value.options) ? value.options.map((option, optionIndex) => {
      if (!isRecord(option) || !readString(option.label)) {
        throw new Error(`Codex question ${questionId} option ${optionIndex + 1} is invalid`);
      }
      const label = readString(option.label)!;
      const description = readString(option.description);
      return { value: label, label, ...(description ? { description } : {}) };
    }) : [];
    return {
      questionId,
      header,
      prompt,
      required: true,
      ...(value.isSecret === true ? { sensitive: true } : {}),
      selection: value.multiSelect === true ? 'multiple' : 'single',
      options,
      allowCustomText: value.isOther === true || options.length === 0,
      allowDismiss: true,
    };
  }

export function mapCodexQuestionResponse(
    request: Extract<AgentInteractionRequest, { kind: 'question' }>,
    response: Extract<AgentInteractionResponse, { kind: 'question' }>,
  ): unknown {
    if (response.dismissed) {
      if (response.answers.length > 0) throw new Error('A dismissed Codex question cannot contain answers');
      return { answers: {} };
    }
    const submitted = new Map(response.answers.map((answer) => [answer.questionId, answer]));
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of request.questions) {
      const answer = submitted.get(question.questionId);
      if (!answer) {
        if (question.required) throw new Error(`Codex question ${question.questionId} requires an answer`);
        continue;
      }
      const allowed = new Set(question.options.map((option) => option.value));
      if (answer.selectedValues.some((value) => !allowed.has(value))) {
        throw new Error(`Codex question ${question.questionId} contains an unknown option`);
      }
      if (question.selection === 'single' && answer.selectedValues.length > 1) {
        throw new Error(`Codex question ${question.questionId} accepts one option`);
      }
      if (answer.customText && !question.allowCustomText) {
        throw new Error(`Codex question ${question.questionId} does not accept custom text`);
      }
      const values = [
        ...answer.selectedValues,
        ...(answer.customText?.trim() ? [answer.customText] : []),
      ];
      if (values.length === 0 && question.required) {
        throw new Error(`Codex question ${question.questionId} requires an answer`);
      }
      answers[question.questionId] = { answers: values };
      submitted.delete(question.questionId);
    }
    if (submitted.size > 0) {
      throw new Error(`Codex question response contains unknown question ${submitted.keys().next().value}`);
    }
    return { answers };
  }
