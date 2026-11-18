/** Identity used by an embedding application's directory, independent of a view. */
export interface SessionDescriptionIdentity {
  hostId?: string;
  providerId: string;
  nativeSessionId: string;
  parentNativeSessionId?: string;
}

export type SessionAttributionTarget =
  | (SessionDescriptionIdentity & { kind: 'session'; sessionIntent?: 'history' })
  | { kind: 'group'; groupType: string; groupId: string };

/** A read-only relationship or role projected by its authoritative owner. */
export interface SessionAttribution {
  id: string;
  kind: string;
  label: string;
  value: string;
  detail?: string;
  target?: SessionAttributionTarget;
}

export interface SessionDescription {
  identity: SessionDescriptionIdentity;
  attributions: readonly SessionAttribution[];
}
