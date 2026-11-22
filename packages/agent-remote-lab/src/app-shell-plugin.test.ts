// @vitest-environment node
import { expect, it } from 'vitest';
import { shellOf, type BuiltFile } from '../app-shell-plugin.js';

/** A build as Vite gives it: the entry with its stylesheet and a font, the App chunk with a shared chunk, and chunks loaded on demand. */
const build: BuiltFile[] = [
  { fileName: 'assets/index-a1.js', type: 'chunk', name: 'index', isEntry: true, imports: ['assets/react-c3.js'], loads: ['assets/index-b2.css', 'assets/digits-d4.woff2'], content: 'entry' },
  { fileName: 'assets/react-c3.js', type: 'chunk', name: 'react', content: 'react' },
  { fileName: 'assets/App-e5.js', type: 'chunk', name: 'App', imports: ['assets/react-c3.js', 'assets/shared-f6.js'], loads: ['assets/App-g7.css'], content: 'app' },
  { fileName: 'assets/shared-f6.js', type: 'chunk', name: 'shared', content: 'shared' },
  { fileName: 'assets/Trace-h8.js', type: 'chunk', name: 'Trace', imports: ['assets/shared-f6.js'], content: 'trace' },
  { fileName: 'assets/jsQR-i9.js', type: 'chunk', name: 'jsQR', content: 'qr' },
  { fileName: 'assets/index-b2.css', type: 'asset', content: 'css' },
  { fileName: 'assets/App-g7.css', type: 'asset', content: 'app css' },
  { fileName: 'assets/digits-d4.woff2', type: 'asset', content: new Uint8Array([1, 2, 3]) },
  { fileName: 'index.html', type: 'asset', content: '<!doctype html>' },
];

it('stores the entry and the App chunk with everything they load before they run, and nothing loaded on demand', () => {
  expect(shellOf(build, ['App']).files).toEqual([
    '/assets/App-e5.js', '/assets/App-g7.css', '/assets/digits-d4.woff2', '/assets/index-a1.js', '/assets/index-b2.css', '/assets/react-c3.js', '/assets/shared-f6.js']);
});

it('names a new version for any change of the build, and the same version for the same build', () => {
  const version = shellOf(build, ['App']).version;
  expect(version).toMatch(/^[0-9a-f]{16}$/);
  expect(shellOf([...build].reverse(), ['App']).version).toBe(version);
  // A chunk loaded on demand changed, and only it: the shell's files are the same, the worker is new.
  const changed = build.map(file => file.fileName === 'assets/Trace-h8.js' ? { ...file, content: 'trace, fixed' } : file);
  expect(shellOf(changed, ['App']).files).toEqual(shellOf(build, ['App']).files);
  expect(shellOf(changed, ['App']).version).not.toBe(version);
  expect(shellOf(build.map(file => file.fileName === 'index.html' ? { ...file, content: '<!doctype html><meta>' } : file), ['App']).version).not.toBe(version);
});

it('fails a build whose start chunk is gone, or whose chunk loads a file the build lacks', () => {
  expect(() => shellOf(build, ['Workbench'])).toThrow('No chunk Workbench to start the app shell with.');
  expect(() => shellOf(build.filter(file => file.fileName !== 'assets/shared-f6.js'), ['App'])).toThrow('assets/shared-f6.js');
});
