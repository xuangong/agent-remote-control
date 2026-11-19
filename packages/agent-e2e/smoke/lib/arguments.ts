/** The value of `--name value` on the command line, or `undefined`. */
export function argument(name: string, argv: string[] = process.argv): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

/** A positive whole number from `--name`, or `fallback` when the flag is absent; any other value is refused, not guessed at. */
export function positiveInteger(name: string, fallback: number, argv: string[] = process.argv): number {
  const text = argument(name, argv);
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number, not "${text}".`);
  return value;
}
