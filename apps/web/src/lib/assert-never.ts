/**
 * Exhaustiveness guard for discriminated unions.
 *
 * Place at the end of a `switch` over a `kind:` (or `outcome:`) discriminator
 * to make the compiler enforce that every case is handled. When a new case is
 * added to the union, every call site that does not yet handle it fails to
 * compile with `Argument of type 'X' is not assignable to parameter of type 'never'`.
 */
export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unexpected value: ${JSON.stringify(value)}`);
}