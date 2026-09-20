import { describe, expect, it } from 'vitest';

import { adaptPreviewContent, PreviewContentError } from './preview-content.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const route = { id: 'preview-one', target: 'http://127.0.0.1:5173', pathMode: 'strip' as const };

describe('adaptPreviewContent', () => {
  it('passes configured-base, event streams, and binary responses through without buffering', async () => {
    for (const input of [
      { contentType: 'text/html', pathMode: 'preserve' as const },
      { contentType: 'text/event-stream', pathMode: 'strip' as const },
      { contentType: 'application/octet-stream', pathMode: 'strip' as const },
    ]) {
      const body = stream('<bytes>');
      const result = await adaptPreviewContent({ body, headers: new Headers({ 'content-type': input.contentType, 'content-length': '7' }),
        route: { ...route, pathMode: input.pathMode }, requestPath: '/index.html', status: 200 });
      expect(result.body).toBe(body);
      expect(result.headers.get('content-length')).toBe('7');
    }
  });

  it('passes partial text representations through without rewriting their byte range', async () => {
    const body = stream('<img src="/partial.png">');
    const headers = new Headers({
      'content-type': 'text/html',
      'content-length': '12',
      'content-range': 'bytes 0-11/26',
      etag: '"partial"',
    });
    const result = await adaptPreviewContent({ body, headers, route, requestPath: '/', status: 206 });

    expect(result.body).toBe(body);
    expect(result.headers).toBe(headers);
    expect(result.headers.get('content-range')).toBe('bytes 0-11/26');
    expect(result.headers.get('content-length')).toBe('12');
    expect(result.headers.get('etag')).toBe('"partial"');
  });

  it('rewrites supported local HTML and CSS references without modifying script text or external URLs', async () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="/app.css" integrity="sha256-old">
      <style>.hero{background:url('/hero.png')} @import "/theme.css";</style>
      <script>fetch('/api'); const example = 'http://127.0.0.1:5173/not-rewritten';</script>
      </head><body style="background-image:url(/inline.png)">
      <img src="http://127.0.0.1:5173/image.png?q=1#hero" srcset="/small.png 1x, https://cdn.test/large.png 2x">
      <a href="/docs">Docs</a><form action="/submit"></form><img src="data:image/png;base64,AAAA"><a href="#part">Part</a>
      </body></html>`;
    const result = await adaptPreviewContent({ body: stream(html), headers: new Headers({ 'content-type': 'text/html; charset=utf-8',
      'content-length': String(html.length), etag: '"strong"' }), route, requestPath: '/index.html', status: 200 });
    const output = await text(result.body);

    expect(output).toContain('href="/p/preview-one/app.css"');
    expect(output).not.toContain('integrity="sha256-old"');
    expect(output).toContain("url('/p/preview-one/hero.png')");
    expect(output).toContain('@import "/p/preview-one/theme.css"');
    expect(output).toContain("fetch('/api')");
    expect(output).toContain("'http://127.0.0.1:5173/not-rewritten'");
    expect(output).toContain('style="background-image:url(/p/preview-one/inline.png)"');
    expect(output).toContain('src="/p/preview-one/image.png?q=1#hero"');
    expect(output).toContain('srcset="/p/preview-one/small.png 1x, https://cdn.test/large.png 2x"');
    expect(output).toContain('src="data:image/png;base64,AAAA"');
    expect(output).toContain('href="#part"');
    expect(result.headers.get('content-length')).toBeNull();
    expect(result.headers.get('etag')).toBeNull();
  });

  it('rewrites standalone stylesheets through parsed declarations and imports', async () => {
    const css = `.a { background: url(/a.png) } .b { mask: url(data:image/svg+xml,x) } @import url("http://127.0.0.1:5173/base.css");`;
    const result = await adaptPreviewContent({ body: stream(css), headers: new Headers({ 'content-type': 'text/css', 'content-length': '120' }),
      route, requestPath: '/app.css', status: 200 });
    const output = await text(result.body);
    expect(output).toContain('url(/p/preview-one/a.png)');
    expect(output).toContain('url(data:image/svg+xml,x)');
    expect(output).toContain('url("/p/preview-one/base.css")');
  });

  it('does not treat url-like text inside CSS strings as a resource reference', async () => {
    const css = `.label::before { content: "url(/literal.png)" } .hero { background: url('/hero.png') }`;
    const result = await adaptPreviewContent({ body: stream(css), headers: new Headers({ 'content-type': 'text/css' }),
      route, requestPath: '/app.css', status: 200 });
    const output = await text(result.body);

    expect(output).toContain('content: "url(/literal.png)"');
    expect(output).toContain("url('/p/preview-one/hero.png')");
  });

  it('decompresses gzip before adapting and removes representation headers', async () => {
    const html = '<img src="/compressed.png">';
    const compressed = stream(html).pipeThrough(new CompressionStream('gzip'));
    const result = await adaptPreviewContent({ body: compressed, headers: new Headers({ 'content-type': 'text/html', 'content-encoding': 'gzip',
      'content-length': '42', 'content-md5': 'old' }), route, requestPath: '/', status: 200 });
    expect(await text(result.body)).toContain('src="/p/preview-one/compressed.png"');
    expect(result.headers.get('content-encoding')).toBeNull();
    expect(result.headers.get('content-md5')).toBeNull();
  });

  it('fails promptly for unsupported compression and decoded bodies above one MiB', async () => {
    const unsupported = adaptPreviewContent({ body: stream('body'), headers: new Headers({ 'content-type': 'text/css', 'content-encoding': 'br' }),
      route, requestPath: '/app.css', status: 200 });
    await expect(unsupported).rejects.toBeInstanceOf(PreviewContentError);
    await expect(unsupported).rejects.toThrow('Unsupported preview content encoding');
    await expect(adaptPreviewContent({ body: stream('x'.repeat(1024 * 1024 + 1)), headers: new Headers({ 'content-type': 'text/html' }),
      route, requestPath: '/', status: 200 })).rejects.toThrow('exceeds the 1 MiB adaptation limit');
    await expect(adaptPreviewContent({ body: stream('not gzip'), headers: new Headers({ 'content-type': 'text/html', 'content-encoding': 'gzip' }),
      route, requestPath: '/', status: 200 })).rejects.toThrow('could not be decompressed');
  });

  it('rejects a known oversized identity representation before pulling its body', async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.close(); } });
    await expect(adaptPreviewContent({ body, headers: new Headers({ 'content-type': 'text/css', 'content-length': String(1024 * 1024 + 1) }),
      route, requestPath: '/app.css', status: 200 })).rejects.toThrow('exceeds the 1 MiB adaptation limit');
    expect(pulls).toBeLessThanOrEqual(1);
  });
});

function stream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(value)); controller.close(); } });
}
async function text(body?: ReadableStream<Uint8Array>): Promise<string> {
  return body ? decoder.decode(await new Response(body).arrayBuffer()) : '';
}

it('preserves root application imports and makes only local manifests credentialed', async () => {
  const rootRoute = { ...route, root: true };
  const source = '<html><head><link rel="manifest" href="/manifest.json"><link rel="manifest" href="https://external.test/manifest.json"><script type="module">import "/@react-refresh"; fetch("/api");</script></head><body><a href="/docs">Docs</a></body></html>';
  const result = await adaptPreviewContent({ body: stream(source), headers: new Headers({ 'content-type': 'text/html' }), route: rootRoute, requestPath: '/', status: 200 });
  const html = await new Response(result.body).text();
  expect(html).toContain('href="/manifest.json" crossorigin="use-credentials"');
  expect(html).toContain('href="https://external.test/manifest.json">');
  expect(html).toContain('import "/@react-refresh"; fetch("/api");');
  expect(html).toContain('src="/_arc/frame.js"');
  const body = stream('import "/module.js"');
  expect((await adaptPreviewContent({ body, headers: new Headers({ 'content-type': 'text/javascript' }), route: rootRoute, requestPath: '/main.js', status: 200 })).body).toBe(body);
});
