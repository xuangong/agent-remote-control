// Copies the package's stylesheets beside the compiled modules, at the paths its exports name.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

for (const path of ['styles.css', 'theme/theme.css', 'primitives/primitives.css']) {
  const source = new URL(`../src/${path}`, import.meta.url);
  if (!existsSync(source)) continue;
  const target = new URL(`../dist/${path}`, import.meta.url);
  mkdirSync(dirname(target.pathname), { recursive: true });
  copyFileSync(source, target);
}
