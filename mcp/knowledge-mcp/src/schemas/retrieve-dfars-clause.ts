/**
 * Input schema for the `retrieve_dfars_clause` tool.
 */
import { z } from "zod";

/**
 * DFARS clause code: full (252.204-7012), partial (252.204), or
 * part-level (252). An optional "DFARS " prefix is tolerated.
 */
export const DFARS_CODE_RE = /^(DFARS\s+)?[0-9]{1,3}(\.[0-9]{1,3})?(-[0-9]{1,4})?$/i;

export const retrieveDfarsClauseInputShape = {
  code: z
    .string()
    .min(2)
    .max(24)
    .regex(
      DFARS_CODE_RE,
      "code must be a DFARS clause code such as 252.204-7012, a prefix such as 252.204, optionally with a DFARS prefix"
    )
    .describe(
      "DFARS clause code, for example 252.204-7012. Exact match returns the full catalog row. " +
        "A partial code such as 252.204 returns up to 5 suggestions."
    ),
};

export const RetrieveDfarsClauseInput = z.object(retrieveDfarsClauseInputShape);
export type RetrieveDfarsClauseInputT = z.infer<typeof RetrieveDfarsClauseInput>;

/**
 * Normalize a user-supplied DFARS code: trim and strip an optional
 * case-insensitive "DFARS" prefix.
 *
 * @param raw - Validated input code.
 * @returns Bare clause code, for example "252.204-7012".
 */
export function normalizeDfarsCode(raw: string): string {
  return raw.trim().replace(/^DFARS\s+/i, "");
}
