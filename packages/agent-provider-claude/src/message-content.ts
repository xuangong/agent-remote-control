import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentInputPart } from '@agent-remote-controller/agent-provider-sdk';
import { IMAGE_INPUT_CAPABILITIES } from '@agent-remote-controller/agent-provider-sdk';

export async function claudeMessageContent(parts: readonly AgentInputPart[]): Promise<SDKUserMessage['message']['content']> {
  const blocks: Exclude<SDKUserMessage['message']['content'], string> = [];
  for (const part of parts) {
    if (part.type === 'text') { blocks.push({ type: 'text', text: part.text }); continue; }
    const file = await open(part.path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > IMAGE_INPUT_CAPABILITIES.maxImageBytes) throw new Error('Claude input image is invalid or exceeds the byte limit.');
      const bytes = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      const data = bytes.subarray(0, offset);
      if (offset !== stat.size || createHash('sha256').update(data).digest('hex') !== part.sha256) throw new Error('Claude input image changed after upload.');
      blocks.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType, data: data.toString('base64') } });
    } finally { await file.close(); }
  }
  return blocks;
}
