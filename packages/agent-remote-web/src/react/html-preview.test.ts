import { expect, it } from 'vitest';
import { renderHtmlPreview, type HtmlPreviewResource } from './html-preview.js';

const resources: Record<string, HtmlPreviewResource> = {
  './chart.png': { mediaType: 'image/png', contentBase64: 'iVBORw0KGgo=' },
  'styles/site.css': { mediaType: 'text/plain', contentBase64: btoa('h1 { color: rebeccapurple; }') },
  './report.html': { mediaType: 'text/html', contentBase64: btoa('<p>not an image</p>') },
};
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

it('inlines local images and stylesheets and blocks scripts, refreshes and every network request', async () => {
  const requested: string[] = [];
  const rendered = parse(await renderHtmlPreview(`<!doctype html><html><head><title>Report</title>
    <meta http-equiv="refresh" content="0; url=https://example.com"><base href="https://example.com/">
    <link rel="stylesheet" href="styles/site.css" media="screen"><link rel="icon" href="./favicon.ico"><link rel="stylesheet" href="https://cdn.example/a.css">
    <script>window.parent.executed = true</script></head>
    <body onload="window.executed = true"><h1>Report</h1><img src="./chart.png" srcset="./chart@2x.png 2x" alt="Chart">
    <img src="https://tracker.example/pixel.png" alt="Remote"><img src="./report.html" alt="Not an image"><img src="./missing.png" alt="Missing"></body></html>`,
    async locator => { requested.push(locator); if (locator === './missing.png') throw new Error('missing'); return resources[locator]; }));
  expect(requested.sort()).toEqual(['./chart.png', './missing.png', './report.html', 'styles/site.css']);
  expect(rendered.querySelectorAll('script, base, meta[http-equiv="refresh"], link[rel="icon"]')).toHaveLength(0);
  const policy = rendered.head.firstElementChild!;
  expect(policy.getAttribute('http-equiv')).toBe('Content-Security-Policy');
  expect(policy.getAttribute('content')).toBe("default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'");
  expect(rendered.querySelector('style')!.textContent).toBe('h1 { color: rebeccapurple; }');
  expect(rendered.querySelector('style')!.getAttribute('media')).toBe('screen');
  expect(rendered.querySelector('link[href="https://cdn.example/a.css"]')).not.toBeNull();
  const image = (alt: string) => rendered.querySelector(`img[alt="${alt}"]`)!;
  expect(image('Chart').getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
  expect(image('Chart').hasAttribute('srcset')).toBe(false);
  expect(image('Remote').getAttribute('src')).toBe('https://tracker.example/pixel.png');
  expect(image('Not an image').hasAttribute('src')).toBe(false);
  expect(image('Missing').hasAttribute('src')).toBe(false);
});

it('opens external links in a new tab, keeps fragment links and turns local links into text', async () => {
  const rendered = parse(await renderHtmlPreview(`<a href="#results">Results</a><a href="https://example.com/docs">Docs</a>
    <a href="mailto:team@example.com">Mail</a><a href="./other.html">Other</a><a href="file:///work/a.md" title="Kept">File</a>
    <a href="javascript:alert(1)">Script</a><map><area href="./area.html" alt="Area"></map>`, async () => undefined));
  const link = (text: string) => Array.from(rendered.querySelectorAll('a')).find(element => element.textContent === text)!;
  expect(link('Results').getAttribute('href')).toBe('#results');
  expect(link('Results').hasAttribute('target')).toBe(false);
  for (const name of ['Docs', 'Mail']) {
    expect(link(name).getAttribute('target')).toBe('_blank');
    expect(link(name).getAttribute('rel')).toBe('noopener noreferrer');
  }
  expect(link('Other').hasAttribute('href')).toBe(false);
  expect(link('Other').getAttribute('title')).toBe('Local file: ./other.html');
  expect(link('File').getAttribute('title')).toBe('Kept');
  expect(link('Script').hasAttribute('href')).toBe(false);
  expect(link('Script').hasAttribute('title')).toBe(false);
  expect(rendered.querySelector('area')!.hasAttribute('href')).toBe(false);
});

it('renders with the resources loaded by the deadline and ignores later ones', async () => {
  let finish!: (resource: HtmlPreviewResource) => void;
  const rendered = parse(await renderHtmlPreview('<img src="./slow.png" alt="Slow"><img src="./fast.png" alt="Fast">', locator =>
    locator === './slow.png' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(resources['./chart.png']), 20));
  expect(rendered.querySelector('img[alt="Fast"]')!.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
  expect(rendered.querySelector('img[alt="Slow"]')!.hasAttribute('src')).toBe(false);
  finish(resources['./chart.png']!);
});

it('reads at most 64 local resources', async () => {
  let reads = 0;
  await renderHtmlPreview(Array.from({ length: 70 }, (_, index) => `<img src="./image-${index}.png">`).join(''), async () => { reads++; return undefined; });
  expect(reads).toBe(64);
});
