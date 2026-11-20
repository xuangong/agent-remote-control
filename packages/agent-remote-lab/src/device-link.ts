import { createContext } from 'react';

/** This device's link to the service while it is down: the words a sidebar says and what it offers. */
export interface DeviceLinkNotice {
  readonly state: 'sign_in' | 'offline';
  readonly signIn: { readonly href: string; onClick(): void };
  retry(): void;
}
/**
 * The page's one connection indicator (design decision 5). The gateway knows the link; a sidebar on screen claims the
 * indicator for its foot, and a page with no sidebar on screen shows it at its top instead.
 */
export interface DeviceLink {
  readonly notice?: DeviceLinkNotice;
  /** Claims the indicator while `shown`; returns the release. */
  claim(shown: boolean): () => void;
}
export const DeviceLinkContext = createContext<DeviceLink | undefined>(undefined);
