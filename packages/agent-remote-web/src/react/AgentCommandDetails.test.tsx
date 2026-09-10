import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render, rerender } from '../test/setup.js';
import { AgentCommandDetails } from './AgentCommandDetails.js';

const command = { id: 'inspect', name: 'inspect', kind: 'skill' as const, description: 'Inspect the workspace',
  documentation: { locator: 'skill:inspect', resourceId: 'doc', status: 'pending' as const } };

it('loads documentation as a resource and renders inert Markdown with a close action', async () => {
  const request = vi.fn(async () => {});
  const close = vi.fn();
  const container = await render(<AgentCommandDetails command={command} resources={{}} onRequestResource={request} onClose={close} />);
  expect(request).toHaveBeenCalledWith(command.documentation);
  const markdown = '---\nname: inspect\n---\n# Inspect 中文\nDo the work.\n<script>alert(1)</script>\n![hidden](https://example.com/pixel.png)';
  const resources = { doc: { status: 'available' as const, mediaType: 'text/plain', sha256: 'hash', byteLength: markdown.length, contentBase64: Buffer.from(markdown).toString('base64') } };
  await rerender(container, <AgentCommandDetails command={command} resources={resources} onRequestResource={request} onClose={close} />);
  expect(container.querySelector('h1')?.textContent).toBe('Inspect 中文');
  expect(container.textContent).not.toContain('name: inspect');
  expect(container.querySelector('script, img')).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => container.querySelector('aside')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(close).toHaveBeenCalledTimes(1);
});

it('keeps the summary available when the Provider has no document and offers retry after a read failure', async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error('Host disconnected')).mockResolvedValue(undefined);
  const container = await render(<AgentCommandDetails command={command} resources={{}} onRequestResource={request} onClose={() => {}} />);
  expect(container.textContent).toContain('Host disconnected');
  await act(async () => (container.querySelector('.agent-command-details-content button') as HTMLButtonElement).click());
  expect(request).toHaveBeenCalledTimes(2);
  await rerender(container, <AgentCommandDetails command={{ id: 'other', name: 'other', kind: 'skill', description: 'Only a description' }} resources={{}} onClose={() => {}} />);
  expect(container.textContent).toContain('Only a description');
  expect(container.textContent).toContain('without full documentation');
});
