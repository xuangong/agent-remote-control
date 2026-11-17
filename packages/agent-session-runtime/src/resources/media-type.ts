export function detectMediaType(bytes: Uint8Array): string {
  if (startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (startsWith(bytes, [255, 216, 255])) return 'image/jpeg';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (startsWith(bytes, [80, 75, 3, 4])) return 'application/zip';

  const text = decodeUtf8(bytes);
  if (text === undefined) return 'application/octet-stream';
  const trimmed = text.trimStart();
  if (/^<svg(?:\s|>)/i.test(trimmed)) return 'image/svg+xml';
  if (/^<!doctype\s+html|^<html(?:\s|>)/i.test(trimmed)) return 'text/html';
  if (looksLikeJson(trimmed)) return 'application/json';
  return 'text/plain';
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function looksLikeJson(value: string): boolean {
  if (!value.startsWith('{') && !value.startsWith('[')) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
