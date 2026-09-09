import { describe, expect, it } from 'vitest';

import { discoverMarkdownLocators, discoverTimelineLocators } from './markdown-locators.js';

describe('discoverMarkdownLocators', () => {
  it('discovers unique relative and opaque Provider-authorized locators', () => {
    expect(discoverMarkdownLocators([
      '![chart](artifacts/chart.png)',
      '[report](./reports/result.pdf "Generated report")',
      '![generated](dsh-attachment:image-7)',
      '[same chart](artifacts/./chart.png)',
    ].join('\n'))).toEqual([
      { locator: 'artifacts/chart.png', normalizedLocator: 'artifacts/chart.png' },
      { locator: './reports/result.pdf', normalizedLocator: 'reports/result.pdf' },
      { locator: 'dsh-attachment:image-7', normalizedLocator: 'dsh-attachment:image-7' },
    ]);
  });

  it('rejects absolute paths, unsafe schemes, authority forms, traversal, anchors, and malformed locators', () => {
    expect(discoverMarkdownLocators([
      '[absolute](</etc/passwd>)',
      '[remote](https://example.com/output.png)',
      '[remote-http](http://example.com/output.png)',
      '[protocol relative](//example.com/output.png)',
      '[file](file:///tmp/output.png)',
      '[embedded](data:image/png;base64,AA==)',
      '[script](javascript:alert(1))',
      '[opaque authority](artifact://session/output.png)',
      '[parent](../secret.txt)',
      '[nested parent](output/../secret.txt)',
      '[opaque parent](artifact:output/../secret.txt)',
      '[anchor](#result)',
      '[empty]()',
      '[safe](output/result.png)',
    ].join('\n'))).toEqual([
      { locator: 'output/result.png', normalizedLocator: 'output/result.png' },
    ]);
  });
});

describe('discoverTimelineLocators', () => {
  it('discovers locators from assistant Markdown and tool file/description strings', () => {
    expect(discoverTimelineLocators({
      type: 'assistant_message', text: 'Created [report](reports/result.pdf).',
    })).toEqual([{ locator: 'reports/result.pdf', normalizedLocator: 'reports/result.pdf' }]);
    expect(discoverTimelineLocators({
      type: 'tool_call', callId: 'write-1', name: 'write', status: 'completed', error: null,
      detail: { type: 'write', filePath: '/tmp/result.json' },
    })).toEqual([]);
    expect(discoverTimelineLocators({
      type: 'tool_call', callId: 'image-1', name: 'image', status: 'completed', error: null,
      detail: { type: 'other', description: 'Saved ![preview](images/preview.png).' },
    })).toEqual([{ locator: 'images/preview.png', normalizedLocator: 'images/preview.png' }]);
  });

  it('does not treat a fetch URL or an in-progress file mutation as a generated resource', () => {
    expect(discoverTimelineLocators({
      type: 'tool_call', callId: 'fetch-1', name: 'fetch', status: 'completed', error: null,
      detail: { type: 'fetch', url: 'https://example.com/file.png' },
    })).toEqual([]);
    expect(discoverTimelineLocators({
      type: 'tool_call', callId: 'write-1', name: 'write', status: 'running', error: null,
      detail: { type: 'write', filePath: 'output.json' },
    })).toEqual([]);
  });
});
