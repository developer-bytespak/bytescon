/**
 * LIKE/ILIKE metacharacter escaping for Prisma string filters.
 *
 * Prisma's `contains` and `startsWith` filters compile to LIKE/ILIKE
 * patterns and pass `%` and `_` through as wildcards. Every user-supplied
 * fragment fed into one of those filters must be escaped so the input
 * matches literally. Postgres uses backslash as the default LIKE escape
 * character.
 */

/**
 * Escape backslash, percent, and underscore so a user-supplied string
 * matches literally inside a Prisma `contains` / `startsWith` filter.
 *
 * @param value - Raw user-supplied filter fragment.
 * @returns The value with LIKE metacharacters backslash-escaped.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
