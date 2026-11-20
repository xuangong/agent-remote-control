/** Who is signed in on this device and what they can do about it: the Settings page and the rail read it; the gateway provides it. */
export interface AccountFacts {
  readonly name?: string;
  readonly email?: string;
  readonly id?: string;
  /** Whether access is confirmed, so Security can be opened. */
  readonly ready: boolean;
  /** Opens the Security panel over the page; focus returns to where it was opened. */
  openSecurity(): void;
  signOut(): void;
}
