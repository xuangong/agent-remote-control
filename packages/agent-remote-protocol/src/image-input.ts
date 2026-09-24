import { type Static, Type } from '@sinclair/typebox';
import { ProtocolVersionSchema } from './version.js';

const Strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });
const Id = Type.String({ minLength: 1, maxLength: 256 });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const ImageMediaType = Type.Union([Type.Literal('image/png'), Type.Literal('image/jpeg'), Type.Literal('image/webp')]);
export type ImageMediaType = Static<typeof ImageMediaType>;
export const MessagePart = Type.Union([
  Strict({ type: Type.Literal('text'), text: Type.String() }),
  Strict({ type: Type.Literal('image'), attachmentId: Id, label: Type.String({ minLength: 1, maxLength: 256 }) }),
]);
export type MessagePart = Static<typeof MessagePart>;
export const UserMessagePart = Type.Union([
  Strict({ type: Type.Literal('text'), text: Type.String() }),
  Strict({ type: Type.Literal('image'), locator: Type.String({ minLength: 1 }), label: Type.String(), sha256: Type.Optional(Digest) }),
]);
export type UserMessagePart = Static<typeof UserMessagePart>;
export const ImageInputCapabilities = Strict({
  mediaTypes: Type.Array(ImageMediaType, { minItems: 1, uniqueItems: true }),
  maxImages: Type.Integer({ minimum: 1, maximum: 8 }),
  maxImageBytes: Type.Integer({ minimum: 1, maximum: 10485760 }),
  maxMessageBytes: Type.Integer({ minimum: 1, maximum: 20971520 }),
});
export type ImageInputCapabilities = Static<typeof ImageInputCapabilities>;
export const ImageUploadReceipt = Strict({ uploadId: Id, offset: Type.Integer({ minimum: 0, maximum: 10485760 }),
  attachment: Type.Optional(Strict({ attachmentId: Id, sha256: Digest, mediaType: ImageMediaType,
    byteLength: Type.Integer({ minimum: 1, maximum: 10485760 }),
    imageDimensions: Strict({ width: Type.Integer({ minimum: 1 }), height: Type.Integer({ minimum: 1 }) }),
  })),
});
export type ImageUploadReceipt = Static<typeof ImageUploadReceipt>;
const UploadIdentity = { requestId: Id, agentId: Id, uploadId: Id };
export const ImageUploadBeginRequest = Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('image_upload_begin'), controlToken: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  payload: Strict({ ...UploadIdentity, sha256: Digest, byteLength: Type.Integer({ minimum: 1, maximum: 10485760 }), mediaType: ImageMediaType }),
});
export type ImageUploadBeginRequest = Static<typeof ImageUploadBeginRequest>;
export const ImageUploadChunkRequest = Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('image_upload_chunk'), controlToken: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  payload: Strict({ ...UploadIdentity, offset: Type.Integer({ minimum: 0, maximum: 10485760 }),
    contentBase64: Type.String({ minLength: 4, maxLength: 43692, pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' }) }),
});
export type ImageUploadChunkRequest = Static<typeof ImageUploadChunkRequest>;
export const ImageUploadFinishRequest = Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('image_upload_finish'), controlToken: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), payload: Strict(UploadIdentity) });
export type ImageUploadFinishRequest = Static<typeof ImageUploadFinishRequest>;
export const ImageUploadResult = Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('image_upload_result'),
  payload: Strict({ requestId: Id, agentId: Id, ...ImageUploadReceipt.properties }),
});
export type ImageUploadResult = Static<typeof ImageUploadResult>;
