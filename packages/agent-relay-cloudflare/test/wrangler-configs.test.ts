import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { unstable_readConfig } from 'wrangler';

/** Reads a wrangler JSONC file whose comments sit on lines of their own. */
function read(path: string): any {
  const text = readFileSync(resolve(__dirname, '..', path), 'utf8');
  return JSON.parse(text.split('\n').filter(line => !line.trim().startsWith('//')).join('\n').replace(/,(\s*[}\]])/g, '$1'));
}

for (const [relay, enabled, partitions, partitionsName] of [
  ['wrangler.jsonc', 'wrangler.journals-enabled.jsonc', 'wrangler.journals.jsonc', 'agent-remote-control-journals'],
  ['../../deploy/self-hosted/wrangler.jsonc', '../../deploy/self-hosted/wrangler.journals-enabled.jsonc', '../../deploy/self-hosted/wrangler.journals.jsonc', 'my-agent-remote-journals'],
] as const) {
  test(`${relay} keeps today's deploy: no journal binding, no journal variable and no journal migration`, () => {
    const config = read(relay);
    expect(config.durable_objects.bindings.map((binding: { name: string }) => binding.name)).toEqual(['RELAY']);
    expect(config.vars).not.toHaveProperty('AGENT_REMOTE_JOURNALS');
    expect(JSON.stringify(config.migrations)).not.toContain('JournalPartition');
  });

  test(`${enabled} is the Relay configuration plus the partitions binding and the variable, and nothing else`, () => {
    const base = read(relay), journals = read(enabled);
    expect(journals.durable_objects.bindings).toEqual([...base.durable_objects.bindings, { name: 'JOURNALS', class_name: 'JournalPartition', script_name: partitionsName }]);
    expect(journals.vars).toEqual({ ...base.vars, AGENT_REMOTE_JOURNALS: '1' });
    const { durable_objects: _a, vars: _b, ...rest } = journals;
    const { durable_objects: _c, vars: _d, ...baseRest } = base;
    expect(rest).toEqual(baseRest);
  });

  test(`${partitions} names the Worker that the Relay binds, owns the class and its migration, and takes no variables`, () => {
    const config = read(partitions);
    expect(config.name).toBe(partitionsName);
    expect(config.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['JournalPartition'] }]);
    expect(config.vars).toBeUndefined();
    expect(config.routes).toBeUndefined();
  });
}

/** A deploy must reach the running Durable Objects at once: Cloudflare defers an update by 300 s unless the config says `immediate`. */
for (const path of ['wrangler.jsonc', 'wrangler.journals.jsonc', 'wrangler.journals-enabled.jsonc', '../../deploy/self-hosted/wrangler.jsonc', '../../deploy/self-hosted/wrangler.journals.jsonc', '../../deploy/self-hosted/wrangler.journals-enabled.jsonc']) {
  test(`${path} applies a code update to its Durable Objects immediately, as the installed wrangler reads it`, () => {
    const config = unstable_readConfig({ config: resolve(__dirname, '..', path) }, {});
    expect(config.durable_objects.code_update_strategy).toEqual({ mode: 'immediate' });
  });
}
