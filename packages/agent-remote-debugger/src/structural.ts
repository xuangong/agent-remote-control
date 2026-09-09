export function stableJsonValue(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = canonicalJsonValue((value as Record<string, unknown>)[key]);
    if (item !== undefined) result[key] = item;
  }
  return result;
}
