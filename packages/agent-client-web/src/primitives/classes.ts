/** A primitive's root class plus the caller's. Stylesheet rules double the class to outrank the Lab's bare element rules. */
export function rootClass(name: string, extra?: string): string {
  return extra ? `${name} ${extra}` : name;
}
