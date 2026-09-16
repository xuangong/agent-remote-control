import { type Static, Type } from '@sinclair/typebox';

import { SafeNonNegativeInteger } from './cursor.js';
import { ProtocolVersionSchema } from './version.js';

const NonEmptyString = Type.String({ minLength: 1 });
const NonNegativeInteger = Type.Integer({ minimum: 0 });
const CanonicalBase64 = Type.String({
  minLength: 4,
  pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
});
const Strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(
  properties,
  { additionalProperties: false },
);

export const ResourceStatus = Type.Union([
  Type.Literal('pending'),
  Type.Literal('available'),
  Type.Literal('failed'),
  Type.Literal('unavailable'),
]);
export type ResourceStatus = Static<typeof ResourceStatus>;

export const ResourceBinding = Strict({
  locator: NonEmptyString,
  resourceId: NonEmptyString,
  status: ResourceStatus,
});
export type ResourceBinding = Static<typeof ResourceBinding>;

export const ResourceRequest = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('resource_request'),
  payload: Strict({ requestId: NonEmptyString, agentId: NonEmptyString, resourceId: NonEmptyString }),
});
export type ResourceRequest = Static<typeof ResourceRequest>;

export const ResourceResolveRequest = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('resource_resolve_request'),
  payload: Strict({
    requestId: NonEmptyString,
    agentId: NonEmptyString,
    locator: NonEmptyString,
    sourceLocator: Type.Optional(NonEmptyString),
  }),
});
export type ResourceResolveRequest = Static<typeof ResourceResolveRequest>;

export const ResourceState = Type.Union([
  Strict({ status: Type.Literal('pending'), retryAfterMs: Type.Integer({ minimum: 1 }) }),
  Strict({
    status: Type.Literal('available'),
    mediaType: NonEmptyString,
    byteLength: NonNegativeInteger,
    sha256: NonEmptyString,
  }),
  Strict({ status: Type.Literal('failed'), message: NonEmptyString, retryable: Type.Boolean() }),
  Strict({ status: Type.Literal('unavailable'), reason: NonEmptyString }),
]);
export type ResourceState = Static<typeof ResourceState>;

export const ResourceResponseState = Type.Union([
  Strict({ status: Type.Literal('pending'), retryAfterMs: Type.Integer({ minimum: 1 }) }),
  Strict({
    status: Type.Literal('available'),
    mediaType: NonEmptyString,
    byteLength: NonNegativeInteger,
    sha256: NonEmptyString,
    contentBase64: CanonicalBase64,
  }),
  Strict({ status: Type.Literal('failed'), message: NonEmptyString, retryable: Type.Boolean() }),
  Strict({ status: Type.Literal('unavailable'), reason: NonEmptyString }),
]);
export type ResourceResponseState = Static<typeof ResourceResponseState>;

export const ResourceResponse = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('resource_response'),
  payload: Strict({
    requestId: NonEmptyString,
    agentId: NonEmptyString,
    resourceId: NonEmptyString,
    state: ResourceResponseState,
  }),
});
export type ResourceResponse = Static<typeof ResourceResponse>;

export const ResourceResolveResponse = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('resource_resolve_response'),
  payload: Strict({
    requestId: NonEmptyString,
    agentId: NonEmptyString,
    binding: ResourceBinding,
  }),
});
export type ResourceResolveResponse = Static<typeof ResourceResolveResponse>;

export const ResourceUpdate = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('resource_update'),
  payload: Strict({
    agentId: NonEmptyString,
    resourceId: NonEmptyString,
    state: ResourceState,
  }),
});
export type ResourceUpdate = Static<typeof ResourceUpdate>;

export const TimelineResourceBindingReplacement = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('timeline_resource_binding_replaced'),
  payload: Strict({
    agentId: NonEmptyString,
    epoch: NonEmptyString,
    seq: SafeNonNegativeInteger,
    previous: ResourceBinding,
    replacement: ResourceBinding,
  }),
});
export type TimelineResourceBindingReplacement = Static<typeof TimelineResourceBindingReplacement>;
