import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {dirname, basename} from 'node:path';
import {access, realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {delimiter, isAbsolute, join, resolve} from 'node:path';
import {resolveCopilotExecutable} from '@orchardworks/agent-provider-copilot';
import {resolveNativeExecutable} from './platform/executables/index.js';

/** Keep terminal and SDK launches on the same configured native installation. */
export async function copilotExecutable(command: string | undefined, env: NodeJS.ProcessEnv): Promise<string> {
  let executable = resolveNativeExecutable(command ?? resolveCopilotExecutable(), '@github/copilot/npm-loader.js', env);
  if (!isAbsolute(executable) && !executable.includes('/') && !executable.includes('\\')) {
    for (const directory of (env.PATH ?? '').split(delimiter)) {
      const candidate = resolve(join(directory, executable));
      try { await access(candidate, constants.R_OK); executable = await realpath(candidate); break; } catch {}
    }
  }
  if (isAbsolute(executable)) executable = await realpath(executable);
  // The official npm loader uses spawnSync and does not forward termination to
  // its native child. Own the binary directly so exit confirms the writer stopped.
  if (basename(executable) === 'npm-loader.js') {
    const manifest = JSON.parse(await readFile(join(dirname(executable), 'package.json'), 'utf8')) as {name?:string};
    if (manifest.name === '@github/copilot') {
      const require = createRequire(executable);
      const report = process.report.getReport() as {header?:{glibcVersionRuntime?:string}};
      const platforms = process.platform === 'linux' && !report.header?.glibcVersionRuntime ? ['linuxmusl','linux'] : [process.platform];
      let native: string | undefined;
      for (const platform of platforms) {try {native = require.resolve(`@github/copilot-${platform}-${process.arch}`); break;}catch{}}
      if (!native) throw new Error('The installed Copilot native binary is unavailable. Reinstall Copilot.');
      executable = native;
    }
  }
  if (!/\.(?:m?js|cjs)$/i.test(executable) || isAbsolute(executable) || executable.includes('/') || executable.includes('\\')) return executable;
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(join(directory, executable));
    try { await access(candidate, constants.R_OK); return candidate; } catch {}
  }
  throw new Error(`Copilot JavaScript entry not found on PATH: ${executable}. Provide an explicit path.`);
}
