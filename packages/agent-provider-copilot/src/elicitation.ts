import { validateInteractionResponse } from '@orchardworks/agent-provider-sdk';
import type { AgentFormField, AgentInteractionRequest, AgentInteractionResponse } from '@orchardworks/agent-provider-sdk';
function isRecord(value: unknown): value is Record<string, unknown> {return !!value && typeof value === 'object' && !Array.isArray(value);}
function readString(value: unknown): string | undefined {return typeof value === 'string' ? value : undefined;}

export function mapCopilotElicitation(params: Record<string, unknown>, requestId: string): AgentInteractionRequest {
  const message = readString(params.message);
  const title = readString(params.elicitationSource) || 'Copilot';
  if (!message || !title) throw new Error('Elicitation needs a message and server name');
  if (params.mode === 'url') {
    const url = readString(params.url);
    if (!url || !/^https?:\/\//i.test(url)) throw new Error('External action requires an HTTP(S) URL');
    const parsed = new URL(url);
    if (!parsed.hostname || parsed.username || parsed.password) throw new Error('External action URL is invalid');
    return { kind: 'external_action', requestId, title, message, url };
  }
  if (params.mode !== undefined && params.mode !== 'form') throw new Error('Unsupported elicitation mode');
  const schema = params.requestedSchema;
  if (!isRecord(schema) || schema.type !== 'object' || !isRecord(schema.properties)) throw new Error('Form requires flat object properties');
  keys(schema, ['$schema', 'type', 'properties', 'required', 'additionalProperties', 'title', 'description']);
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new Error('Additional properties are unsupported');
  const entries = Object.entries(schema.properties);
  if (!entries.length || entries.length > 64) throw new Error('Form field count is unsupported');
  const required = schema.required === undefined ? [] : strings(schema.required);
  if (new Set(required).size !== required.length || required.some((key) => !Object.hasOwn(schema.properties as object, key))) throw new Error('Required fields are invalid');
  const fields = entries.map(([id, value]) => field(id, value, required.includes(id)));
  for (const field of fields) if (field.defaultValue !== undefined) validateInteractionResponse(
    { kind: 'form', requestId, title, message, fields: [field] },
    { kind: 'form', action: 'submit', values: { [field.fieldId]: field.defaultValue } },
  );
  return { kind: 'form', requestId, title, message, fields };
}

function field(fieldId: string, value: unknown, required: boolean): AgentFormField {
  if (!fieldId || fieldId.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(fieldId) || !isRecord(value)) throw new Error('Invalid form field');
  const sensitive = value.isSecret === true || value.sensitive === true || value.writeOnly === true;
  for (const key of ['isSecret', 'sensitive', 'writeOnly']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('Invalid sensitive marker');
  for (const key of ['title', 'description']) if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error('Invalid field label');
  if (sensitive && value.default !== undefined) throw new Error('Sensitive defaults cannot be published');
  const base = { fieldId, label: readString(value.title) || fieldId, required, ...(readString(value.description) ? { description: readString(value.description)! } : {}), ...(sensitive ? { sensitive: true } : {}) };
  const common = ['type', 'title', 'description', 'isSecret', 'sensitive', 'writeOnly', 'default'];
  if (value.type === 'string' && ('enum' in value || 'oneOf' in value)) {
    keys(value, [...common, 'enum', 'enumNames', 'oneOf']);
    const options = enumOptions(value, 'oneOf');
    if (value.default !== undefined && (typeof value.default !== 'string' || !options.some((o) => o.value === value.default))) throw new Error('Invalid select default');
    return { ...base, type: 'select', options, ...(value.default !== undefined ? { defaultValue: value.default as string } : {}) };
  }
  if (value.type === 'string') {
    keys(value, [...common, 'minLength', 'maxLength', 'format']);
    bounds(value, 'minLength', 'maxLength', true);
    if (value.format !== undefined && !['email', 'uri', 'date', 'date-time'].includes(String(value.format))) throw new Error('Unsupported string format');
    if (value.default !== undefined && typeof value.default !== 'string') throw new Error('Invalid text default');
    return { ...base, type: 'text', ...copy(value, ['minLength', 'maxLength', 'format']), ...(value.default !== undefined ? { defaultValue: value.default as string } : {}) } as AgentFormField;
  }
  if (value.type === 'number' || value.type === 'integer') {
    keys(value, [...common, 'minimum', 'maximum']);
    bounds(value, 'minimum', 'maximum', false);
    if (value.default !== undefined && (typeof value.default !== 'number' || !Number.isFinite(value.default) || (value.type === 'integer' && !Number.isSafeInteger(value.default)))) throw new Error('Invalid number default');
    return { ...base, type: 'number', integer: value.type === 'integer', ...copy(value, ['minimum', 'maximum']), ...(value.default !== undefined ? { defaultValue: value.default as number } : {}) };
  }
  if (value.type === 'boolean') {
    keys(value, common);
    if (value.default !== undefined && typeof value.default !== 'boolean') throw new Error('Invalid boolean default');
    return { ...base, type: 'boolean', ...(value.default !== undefined ? { defaultValue: value.default as boolean } : {}) };
  }
  if (value.type === 'array') {
    keys(value, [...common, 'minItems', 'maxItems', 'items', 'uniqueItems']);
    if (value.uniqueItems !== undefined && value.uniqueItems !== true) throw new Error('Repeated array values are unsupported');
    bounds(value, 'minItems', 'maxItems', true);
    if (!isRecord(value.items)) throw new Error('Array items require finite choices');
    keys(value.items, ['type', 'enum', 'anyOf']);
    if (value.items.type !== undefined && value.items.type !== 'string') throw new Error('Array choices must be strings');
    const options = enumOptions(value.items, 'anyOf');
    const defaultValue = value.default === undefined ? undefined : strings(value.default);
    if (defaultValue && (new Set(defaultValue).size !== defaultValue.length || defaultValue.some((v) => !options.some((o) => o.value === v)))) throw new Error('Invalid multiselect default');
    return { ...base, type: 'multiselect', options, ...copy(value, ['minItems', 'maxItems']), ...(defaultValue ? { defaultValue } : {}) };
  }
  throw new Error('Unsupported form field type');
}

function enumOptions(value: Record<string, unknown>, variant: string): Array<{ value: string; label: string }> {
  if ('enum' in value && variant in value) throw new Error('Conflicting choice schemas');
  let options: Array<{ value: string; label: string }>;
  if ('enum' in value) {
    const values = strings(value.enum);
    const labels = value.enumNames === undefined ? values : strings(value.enumNames);
    if (labels.length !== values.length) throw new Error('Choice labels do not match values');
    options = values.map((entry, index) => ({ value: entry, label: labels[index]! }));
  } else {
    if (!Array.isArray(value[variant])) throw new Error('Choices require enum values');
    options = (value[variant] as unknown[]).map((option) => {
      if (!isRecord(option)) throw new Error('Invalid choice');
      keys(option, ['const', 'title']);
      if (typeof option.const !== 'string' || typeof option.title !== 'string') throw new Error('Invalid titled choice');
      return { value: option.const, label: option.title };
    });
  }
  if (!options.length || options.length > 256 || new Set(options.map((o) => o.value)).size !== options.length || options.some((o) => !o.value || !o.label)) throw new Error('Invalid or excessive choices');
  return options;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error('Expected string array');
  return value as string[];
}
function keys(value: Record<string, unknown>, supported: string[]): void {
  if (Object.keys(value).some((key) => !supported.includes(key))) throw new Error('Unsupported schema constraint');
}
function bounds(value: Record<string, unknown>, min: string, max: string, integer: boolean): void {
  for (const key of [min, max]) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || (integer && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)))) throw new Error('Invalid field bounds');
  if (typeof value[min] === 'number' && typeof value[max] === 'number' && value[min] > value[max]) throw new Error('Inverted field bounds');
}
function copy(value: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}
