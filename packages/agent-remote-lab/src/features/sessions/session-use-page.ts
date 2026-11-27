import { addressWithoutSession, readSessionUseLink, type SessionUseRequest } from './session-use.js';

/**
 * The use the page was opened with. Reading it removes the session and the use from the address, so that nothing opens
 * the session before the person has answered; the request stays here until `finishSessionUse`, because a render may run
 * twice and an App mounted again meanwhile must still ask.
 */
let pending: SessionUseRequest | undefined;

export interface SessionUsePage { readonly location: Pick<Location, 'href' | 'search'>; readonly history: Pick<History, 'replaceState' | 'state'> }

export function takeSessionUse(page: SessionUsePage = window): SessionUseRequest | undefined {
  const request = readSessionUseLink(page.location.search);
  if (request) {
    pending = request;
    page.history.replaceState(page.history.state, '', addressWithoutSession(page.location.href));
  }
  return pending;
}

/** The person answered, or the page was left: a later mount asks nothing. */
export function finishSessionUse(): void { pending = undefined; }
