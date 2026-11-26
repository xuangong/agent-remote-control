import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIN_PI_VERSION, parsePiVersion, piInvocation, piVersionIssue, resolvePiExecutable } from './executable.js';

const roots: string[] = [];
const root = () => { const path = realpathSync(mkdtempSync(join(tmpdir(), 'pi-exe-'))); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const executable = (path: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, '#!/usr/bin/env node\n'); chmodSync(path, 0o755); return path; };

describe('pi executable', () => {
  it('finds pi on PATH first and returns the real file behind a symbolic link', () => {
    const home = root();
    const real = executable(join(home, 'lib', 'cli.js'));
    mkdirSync(join(home, 'bin')); symlinkSync(real, join(home, 'bin', 'pi'));
    expect(resolvePiExecutable(undefined, { HOME: home, PATH: join(home, 'bin') })).toBe(real);
  });

  it('finds the newest nvm Node version when the login environment has no PATH to pi', () => {
    const home = root();
    executable(join(home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin', 'pi'));
    const newest = executable(join(home, '.nvm', 'versions', 'node', 'v24.22.2', 'bin', 'pi'));
    executable(join(home, '.nvm', 'versions', 'node', 'v9.0.0', 'bin', 'pi'));
    expect(resolvePiExecutable('pi', { HOME: home, PATH: '/nonexistent' })).toBe(newest);
  });

  it('takes an explicit path as it is and rejects one that is not an executable file', () => {
    const home = root();
    const path = executable(join(home, 'custom-pi'));
    expect(resolvePiExecutable(path, { HOME: home, PATH: '' })).toBe(path);
    expect(() => resolvePiExecutable(join(home, 'missing'), { HOME: home })).toThrow(/not an executable file/);
  });

  it('says where to configure pi when it is nowhere', () => {
    expect(() => resolvePiExecutable('pi', { HOME: root(), PATH: '/nonexistent' })).toThrow(/AGENT_HOST_PI/);
  });

  it('runs a JavaScript entry under the current Node and anything else by itself', () => {
    expect(piInvocation('/x/cli.js', ['--version'])).toEqual({ command: process.execPath, args: ['/x/cli.js', '--version'] });
    expect(piInvocation('/x/pi', ['--version'])).toEqual({ command: '/x/pi', args: ['--version'] });
  });

  it('reads the version and refuses one older than the adapter was checked against', () => {
    expect(parsePiVersion('0.73.1\n')).toBe('0.73.1');
    expect(parsePiVersion('pi 0.73.1')).toBeUndefined();
    expect(piVersionIssue(`${MIN_PI_VERSION}\n`)).toBeUndefined();
    expect(piVersionIssue('0.74.0')).toBeUndefined();
    expect(piVersionIssue('0.72.9')?.message).toMatch(/0\.73\.1 or newer/);
    expect(piVersionIssue('')?.message).toMatch(/did not report/);
  });
});
