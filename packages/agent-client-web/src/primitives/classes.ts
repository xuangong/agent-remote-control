/** A primitive's root class, doubled so it outranks the Lab's bare element rules, plus the caller's class. */
export function rootClass(name: string, extra?: string): string {
  return extra ? `${name} ${name} ${extra}` : `${name} ${name}`;
}
