import { result, type InvariantResult, type PageReport, type Transcript, type Violation } from './types.js';
import { markers, payloadOf, received, sent } from './wire.js';

/** M6: while a terminal owns the session the page is read-only: no `session_control` frame names a native CLI owner and grants control. */
export function leaseFollowsNativeOwner(transcript: Transcript): InvariantResult {
  const violations: Violation[] = [];
  const states = received(transcript, 'session_control');
  for (const frame of states) {
    const payload = payloadOf(frame.message);
    if (payload.nativeOwner?.kind === 'native_cli' && (payload.access === 'control' || payload.token)) {
      violations.push({ message: 'a terminal owns the session but the page was given control', at: frame.t });
    }
  }
  return result('lease-follows-native-owner', states.length, violations);
}

/** M6: each prompt the scenario wrote (from the page or a terminal) is shown exactly once at the end. */
export function noLostOrDoubledMessage(page: PageReport, prompts: string[]): InvariantResult {
  const violations: Violation[] = [];
  for (const prompt of prompts) {
    const count = page.finalRows.filter(row => row.kind === 'user_message' && row.text.includes(prompt)).length;
    if (count === 0) violations.push({ message: `the message "${prompt}" is lost` });
    if (count > 1) violations.push({ message: `the message "${prompt}" is shown ${count} times` });
  }
  return result('no-lost-or-doubled-message', prompts.length, violations);
}

/** M6: every take-over request is answered with a `session_control` frame that grants control to the page. */
export function takeOverWorks(transcript: Transcript): InvariantResult {
  const violations: Violation[] = [];
  const requests = sent(transcript, 'session_control_request').filter(frame => payloadOf(frame.message).action === 'take_over');
  for (const request of requests) {
    const { requestId } = payloadOf(request.message);
    const answer = received(transcript, 'session_control').find(frame => payloadOf(frame.message).requestId === requestId);
    if (!answer) violations.push({ message: `take-over ${requestId} was not answered`, at: request.t });
    else if (payloadOf(answer.message).access !== 'control') violations.push({ message: `take-over ${requestId} did not grant control`, at: answer.t });
  }
  return result('take-over-works', requests.length, violations);
}

/** M6: text a terminal wrote reaches the page's timeline within `withinMs`, as a page entry or a live entry. */
export function terminalRowsAppear(transcript: Transcript, withinMs = 10_000): InvariantResult {
  const violations: Violation[] = [];
  const writes = markers(transcript, 'terminal-write');
  const carriers = received(transcript).filter(frame => frame.message.type === 'agent_stream' || frame.message.type === 'timeline_page');
  for (const write of writes) {
    const text = String(write.detail?.text ?? '');
    const arrived = carriers.find(frame => frame.t >= write.t && JSON.stringify(frame.message).includes(JSON.stringify(text).slice(1, -1)));
    if (!arrived) violations.push({ message: `terminal text "${text}" never reached the timeline`, at: write.t });
    else if (arrived.t - write.t > withinMs) violations.push({ message: `terminal text "${text}" took ${arrived.t - write.t} ms to reach the timeline`, at: write.t });
  }
  return result('terminal-rows-appear', writes.length, violations);
}
