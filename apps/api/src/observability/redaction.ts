/**
 * Generic recursive redaction used by both the audit summary whitelist and the
 * Pino logger redact paths. Walks objects and arrays up to `depth` levels; any
 * key matching `keys` is replaced with "[REDACTED]". Non-primitive values beyond
 * the depth budget collapse to "[REDACTED]" as well.
 */

export const DEFAULT_REDACT_KEYS = /^(passportNumber|dateOfBirth|nationality)$/i;

export interface RedactOptions {
  depth?: number;
  keys?: RegExp;
}

export function redact(value: unknown, opts: RedactOptions = {}): unknown {
  const depth = opts.depth ?? 4;
  const keys = opts.keys ?? DEFAULT_REDACT_KEYS;
  return walk(value, depth, keys, new WeakSet());
}

function walk(value: unknown, depth: number, keys: RegExp, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth <= 0) return "[REDACTED]";

  if (Array.isArray(value)) {
    if (seen.has(value)) return "[REDACTED]";
    seen.add(value);
    return value.map(item => walk(item, depth - 1, keys, seen));
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return "[REDACTED]";
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = keys.test(k) ? "[REDACTED]" : walk(v, depth - 1, keys, seen);
    }
    return out;
  }

  return "[REDACTED]";
}