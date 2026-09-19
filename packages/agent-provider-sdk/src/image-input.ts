export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ImageInputCapabilities {
  mediaTypes: ImageMediaType[];
  maxImages: number;
  maxImageBytes: number;
  maxMessageBytes: number;
}

export const IMAGE_INPUT_CAPABILITIES: ImageInputCapabilities = {
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp'],
  maxImages: 8,
  maxImageBytes: 10 * 1024 * 1024,
  maxMessageBytes: 20 * 1024 * 1024,
};

export type AgentInputPart = { type: 'text'; text: string }
  | { type: 'image'; path: string; mediaType: ImageMediaType; sha256: string; label: string };

export type AgentUserMessagePart = { type: 'text'; text: string }
  | { type: 'image'; locator: string; label: string; sha256?: string };
