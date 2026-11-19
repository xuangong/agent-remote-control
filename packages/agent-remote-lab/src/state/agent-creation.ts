/**
 * Agent creation and resume: when a session may be created or resumed, which reservation a retry reuses, how a
 * failure is classified, and the session a resume produces.
 *
 * Contract
 * - Pure. The shell asks the Host, applies the answers and owns the reservation ref; this module decides.
 * - `mayCreate`: creation needs a provider, an available catalog, no other opening in flight, and, for a bot, a
 *   directory.
 * - `reservationFor`: a retry keeps the reservation of the attempt it repeats, so the Host creates one session. A bot
 *   attempt reuses only a bot reservation and otherwise starts a new one; an ordinary attempt reuses whatever
 *   reservation is held.
 * - `planningOption`: planning is requested only when the form asks for it and the provider takes it (not `dsh`).
 * - `classifyCreationFailure`: a request the Host refused for its content (invalid request, missing workspace or
 *   provider, quota, an operation conflict) releases the reservation. Any other failure keeps it, and its message
 *   says that Retry keeps the same reservation. The native file limit raises a notice, not a failure line, and says
 *   creation may have been partial. A bot's failure shows in the New bot sheet only before its session exists;
 *   afterwards the roster shows the group's own state.
 * - `mayResume`: only a session with persistence that is not a child (a child opens through its parent) and while
 *   nothing else is opening.
 * - `resumedSession`: the resumed session keeps what is known of the opened one and takes the Host's answer.
 */
export interface CreationReservation { readonly bot?: true }

export function mayCreate(facts: { readonly providerId: string | undefined; readonly unavailableReason: string | undefined;
  readonly opening: boolean; readonly bot: boolean; readonly hasDirectory: boolean }): boolean {
  return !!facts.providerId && !facts.unavailableReason && !facts.opening && (!facts.bot || facts.hasDirectory);
}

export function reservationFor<Held extends CreationReservation, Fresh>(held: Held | undefined, bot: boolean, fresh: () => Fresh): Held | Fresh {
  if (bot) return held?.bot ? held : fresh();
  return held ?? fresh();
}

export function planningOption(wanted: boolean, providerId: string): { planning?: true } {
  return wanted && providerId !== 'dsh' ? { planning: true } : {};
}

const refusedForContent = ['invalid_request', 'workspace_not_found', 'provider_not_found', 'session_quota_exceeded', 'operation_conflict'];
const partialCreationNote = 'Creation may have partially completed. Inspect the native session list before creating a new intent. Retry keeps the same reservation.';

export interface CreationFailure {
  /** The reservation is released: the next attempt is a new one. */
  readonly releasesReservation: boolean;
  /** The Host's native file limit: shown as a notice with the partial-creation warning, not as a failure line. */
  readonly partialNotice: boolean;
  /** The failure line, when there is one. */
  readonly failure?: string;
  /** The failure for the New bot sheet, when there is one. */
  readonly botSheetFailure?: string;
}

export function classifyCreationFailure(facts: { readonly code?: string; readonly directoryError: boolean; readonly hasDirectory: boolean;
  readonly reservationHeld: boolean; readonly bot: boolean; readonly botSessionCreated: boolean; readonly message: string }): CreationFailure {
  const code = facts.directoryError ? facts.code : undefined;
  const partialNotice = code === 'native_file_limit';
  const releasesReservation = code !== undefined && refusedForContent.includes(code);
  const failure = `${facts.message}${facts.hasDirectory && !releasesReservation && facts.reservationHeld ? ' Retry keeps the same session reservation and settings.' : ''}`;
  if (facts.bot) return { releasesReservation, partialNotice, ...(facts.botSessionCreated ? {} : { botSheetFailure: failure }) };
  return { releasesReservation, partialNotice, ...(partialNotice ? {} : { failure }) };
}

export function partialCreationMessage(base: string): string {
  return `${base} ${partialCreationNote}`;
}

export function mayResume(facts: { readonly hasPersistence: boolean; readonly isChild: boolean; readonly opening: boolean }): boolean {
  return facts.hasPersistence && !facts.isChild && !facts.opening;
}

export function resumedSession<Opened extends { readonly title: string; readonly hostId?: string }>(
  opened: Opened | undefined, persistence: { readonly providerId: string; readonly sessionId: string },
  response: { readonly agentId: string; readonly nativeSessionId?: string },
) {
  const hostId = opened?.hostId ?? 'local';
  return { ...opened, agentId: response.agentId, providerId: persistence.providerId, nativeSessionId: response.nativeSessionId ?? persistence.sessionId,
    hostId, title: opened?.title ?? 'Resumed session' };
}

export const sessionQuotaMessage = 'Session creation limit reached. Existing sessions remain available. Ask the owner to raise your limit.';

/** A Host that reports a quota refuses another session once its used count reaches the limit. */
export function sessionQuotaReached(quota: { readonly used: number; readonly limit: number } | undefined): boolean {
  return !!quota && quota.used >= quota.limit;
}
