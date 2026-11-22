// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyMessage, formattedMessage } from './message-copy.js';

const rendered = (html: string) => { const entry = document.createElement('div'); entry.innerHTML = html; return entry; };

describe('formattedMessage', () => {
  it('keeps a message\'s formatting and leaves out the page\'s controls and markers', () => {
    const entry = rendered(`<span class="agent-entry-actions"><button>Copy</button></span>
      <div class="orchard-bubble"><article class="agent-timeline-item agent-message agent-message-assistant" aria-label="Assistant">
        <div class="agent-markdown"><ul><li><strong>Immediacy</strong>: arrives at once</li></ul>
        <p>Read <code>notes.md</code> and <a href="https://example.com/doc" class="agent-link" target="_blank">the doc</a>.</p>
        <span aria-hidden="true">decoration</span><button type="button">Copy code</button><svg><path d="M0 0"/></svg></div>
      </article></div><div class="agent-bubble-time">17:22</div>`);
    expect(formattedMessage(entry)).toBe('<div><ul><li><strong>Immediacy</strong>: arrives at once</li></ul>\n        '
      + '<p>Read <code>notes.md</code> and <a href="https://example.com/doc">the doc</a>.</p>\n        </div>');
  });

  it('unwraps elements that carry no formatting into their text', () => {
    const entry = rendered('<article class="agent-message"><custom-tag><p>Hi <font color="red">there</font></p></custom-tag></article>');
    expect(formattedMessage(entry)).toBe('<p>Hi there</p>');
  });

  it('drops addresses that mean nothing elsewhere: a script link loses its address, a page-only image leaves its words', () => {
    const entry = rendered('<article class="agent-message"><p><a href="javascript:alert(1)">run</a> <img src="blob:http://x/1" alt="diagram"> <img src="https://example.com/a.png" alt="a" onerror="x()"></p></article>');
    expect(formattedMessage(entry)).toBe('<p><a>run</a> diagram <img src="https://example.com/a.png" alt="a"></p>');
  });

  it('has nothing to add for an element that holds no message', () => {
    expect(formattedMessage(rendered('<div class="agent-tool">ran a command</div>'))).toBeUndefined();
    expect(formattedMessage(undefined)).toBeUndefined();
  });
});

describe('copyMessage', () => {
  const clipboard = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard') ?? Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  afterEach(() => { vi.unstubAllGlobals(); if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard); else delete (navigator as { clipboard?: unknown }).clipboard; });
  const entry = () => rendered('<article class="agent-message"><p><strong>Ship</strong> it</p></article>');
  const read = (blob: Blob) => new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });

  it('writes the Markdown as plain text and the formatting as HTML together', async () => {
    const write = vi.fn(async () => {}), writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write, writeText } });
    vi.stubGlobal('ClipboardItem', class { constructor(readonly items: Record<string, Blob>) {} });
    await copyMessage('**Ship** it', entry());
    expect(writeText).not.toHaveBeenCalled();
    const [[[item]]] = write.mock.calls as unknown as [[[{ items: Record<string, Blob> }]]];
    expect(await read(item.items['text/plain']!)).toBe('**Ship** it');
    expect(await read(item.items['text/html']!)).toBe('<p><strong>Ship</strong> it</p>');
  });

  it('falls back to the text alone where rich writes are missing or refused', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await copyMessage('**Ship** it', entry());
    const write = vi.fn(async () => { throw new Error('NotAllowedError'); });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write, writeText } });
    vi.stubGlobal('ClipboardItem', class { constructor(readonly items: Record<string, Blob>) {} });
    await copyMessage('**Ship** it', entry());
    expect(writeText.mock.calls).toEqual([['**Ship** it'], ['**Ship** it']]);
  });

  it('rejects when there is no clipboard at all', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await expect(copyMessage('text')).rejects.toThrow();
  });
});
