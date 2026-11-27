import { useRef, useState } from 'react';
import type { QuestionDraft } from './QuestionCard.js';

/**
 * An interaction card renders from its own draft, which a typed character changes within the event itself. An owner that hands the
 * draft back later (after a render of its own, or a store that publishes) would otherwise show the old text for a render, and the
 * browser drops the input method's composition when a field's value is written while it composes. A draft the owner offers that the
 * card did not report (another device's answer, a reset) replaces the card's own.
 */
export function useInteractionDraft(offered: QuestionDraft | undefined, onChange?: (draft: QuestionDraft) => void): readonly [QuestionDraft, (next: QuestionDraft) => void] {
  const [draft, setLocal] = useState<QuestionDraft>(offered ?? { answers: {} });
  const [seen, setSeen] = useState(offered);
  const reported = useRef(new WeakSet<QuestionDraft>());
  if (offered !== seen) {
    setSeen(offered);
    if (!offered || !reported.current.has(offered)) setLocal(offered ?? { answers: {} });
  }
  return [draft, next => { reported.current.add(next); setLocal(next); onChange?.(next); }];
}
