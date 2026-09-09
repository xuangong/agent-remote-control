import { describe, expect, it } from 'vitest';
import { mapCodexElicitation } from './elicitation.js';

const map = (schema: unknown) => mapCodexElicitation({ mode: 'openai/form', serverName: 'mcp', message: 'Fill in', requestedSchema: schema }, 'form');
describe('Codex form schema normalization', () => {
  it('maps booleans and all titled and untitled enum encodings losslessly', () => {
    expect(map({ type: 'object', properties: {
      enabled: { type: 'boolean', default: false },
      legacy: { type: 'string', enum: ['x', 'y'], enumNames: ['X', 'Y'], default: 'y' },
      titled: { type: 'string', oneOf: [{ const: 'x', title: 'X' }] },
      multi: { type: 'array', items: { type: 'string', enum: ['x'] }, default: ['x'] },
    } })).toMatchObject({ fields: [
      { type: 'boolean', defaultValue: false },
      { type: 'select', options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }], defaultValue: 'y' },
      { type: 'select', options: [{ value: 'x', label: 'X' }] },
      { type: 'multiselect', options: [{ value: 'x', label: 'x' }], defaultValue: ['x'] },
    ] });
  });
  it.each([
    { type: 'string', pattern: '^a' },
    { type: ['string', 'null'] },
    { type: 'object', properties: {} },
    { type: 'array', items: { type: 'string' } },
    { type: 'number', multipleOf: 2 },
    { type: 'string', minLength: 5, maxLength: 1 },
    { type: 'string', minLength: 5, default: 'a' },
    { type: 'number', minimum: 5, default: 1 },
    { type: 'array', minItems: 2, items: { enum: ['x', 'y'] }, default: ['x'] },
    { type: 'string', sensitive: true, default: 'secret' },
    { type: 'string', enum: ['x'], enumNames: [] },
  ])('declines constraints that cannot be represented or defaults that violate them', (schema) => {
    expect(() => map({ type: 'object', properties: { input: schema } })).toThrow();
  });
  it('rejects unsafe external action schemes', () => {
    expect(() => mapCodexElicitation({ mode: 'url', serverName: 'mcp', message: 'Follow', url: 'javascript:alert(1)' }, 'url')).toThrow();
  });
});
