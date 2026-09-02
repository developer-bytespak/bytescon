/**
 * Deep sanitizer for untrusted JSON columns (bidGuidanceJson,
 * blockersJson). Every string leaf passes through the shared sanitize()
 * (control-char strip plus length cap); arrays, object key counts, and
 * recursion depth are bounded so a hostile or runaway JSON document
 * cannot blow past the response caps or recurse forever.
 */
import { sanitize } from "@bytescon/mcp-shared";

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;
const KEY_CAP = 200;

/**
 * Recursively sanitize a JSON value from the database before returning
 * it to the host LLM.
 *
 * @param value - Untrusted JSON value (already parsed by Prisma).
 * @param fieldCap - Character cap applied to every string leaf.
 * @param depth - Internal recursion counter; callers omit it.
 * @returns A sanitized copy. Values beyond the depth bound, and
 *   non-JSON types (bigint, function, symbol, undefined), become null.
 */
export function sanitizeJsonDeep(value: unknown, fieldCap = 1000, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (typeof value === "string") return sanitize(value, fieldCap);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((v) => sanitizeJsonDeep(v, fieldCap, depth + 1));
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).slice(0, MAX_OBJECT_KEYS)) {
      out[sanitize(key, KEY_CAP)] = sanitizeJsonDeep(source[key], fieldCap, depth + 1);
    }
    return out;
  }
  return null;
}
