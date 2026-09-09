import { isRecord, nonEmptyString, safeNonNegativeInteger } from './native.js';

export interface DshImageReference {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

export interface DshContentRead {
  text: string;
  reasoning: string[];
  images: Array<{ locator: string; reference: DshImageReference }>;
  diagnostics: string[];
}

export function readDshContent(input: unknown): DshContentRead {
  if (!Array.isArray(input)) {
    return { text: '', reasoning: [], images: [], diagnostics: ['DSH content must be an array.'] };
  }
  const text: string[] = [];
  const reasoning: string[] = [];
  const images: DshContentRead['images'] = [];
  const diagnostics: string[] = [];
  for (const block of input) {
    if (!isRecord(block)) {
      diagnostics.push('DSH content contains a non-object block.');
      continue;
    }
    const type = nonEmptyString(block.type);
    if (type === 'text' && typeof block.text === 'string') {
      text.push(block.text);
      continue;
    }
    if (type === 'reasoning' && typeof block.text === 'string') {
      reasoning.push(block.text);
      continue;
    }
    if (type === 'redacted_reasoning') {
      reasoning.push(typeof block.summary === 'string' ? block.summary : '[Redacted reasoning]');
      continue;
    }
    if (type === 'image') {
      const raw = isRecord(block.attachment) ? block.attachment : block;
      const attachmentId = nonEmptyString(raw.attachmentId);
      const mediaType = nonEmptyString(raw.mediaType);
      const bytes = safeNonNegativeInteger(raw.bytes);
      const width = safeNonNegativeInteger(raw.width);
      const height = safeNonNegativeInteger(raw.height);
      if (attachmentId && mediaType && bytes !== undefined && width !== undefined && height !== undefined) {
        const name = nonEmptyString(raw.name) ?? nonEmptyString(raw.alt);
        const reference = { attachmentId, mediaType, bytes, width, height, ...(name ? { name } : {}) };
        const locator = `dsh-attachment:${attachmentId}`;
        images.push({ locator, reference });
        text.push(`![${name ?? 'image'}](${locator})`);
      } else {
        diagnostics.push('DSH image content lacks a complete attachment reference.');
      }
      continue;
    }
    if (type === 'attachment') {
      diagnostics.push(`Unsupported DSH attachment ${nonEmptyString(block.name) ?? 'without a name'}.`);
      continue;
    }
    if (type === 'tool-call') continue;
    diagnostics.push(`Unsupported DSH content ${type ?? 'without a type'}.`);
  }
  return { text: text.join(''), reasoning, images, diagnostics };
}
