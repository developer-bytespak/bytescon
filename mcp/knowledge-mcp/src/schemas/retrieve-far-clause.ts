/**
 * Input schema for the `retrieve_far_clause` tool.
 *
 * Raw shape exported for McpServer.tool() registration (SDK contract);
 * composed object exported for unit tests.
 */
import { z } from "zod";

/**
 * FAR clause code: full (52.219-14), partial (52.219), or part-level (52).
 * An optional "FAR " prefix is tolerated and stripped by the handler.
 */
export const FAR_CODE_RE = /^(FAR\s+)?[0-9]{1,3}(\.[0-9]{1,3})?(-[0-9]{1,4})?$/i;

export const retrieveFarClauseInputShape = {
  code: z
    .string()
    .min(2)
    .max(24)
    .regex(
      FAR_CODE_RE,
      "code must be a FAR clause code such as 52.219-14, a prefix such as 52.219, optionally with a FAR prefix"
    )
    .describe(
      "FAR clause code, for example 52.219-14. Exact match returns the full catalog row. " +
        "A partial code such as 52.219 returns up to 5 suggestions."
    ),
};

export const RetrieveFarClauseInput = z.object(retrieveFarClauseInputShape);
export type RetrieveFarClauseInputT = z.infer<typeof RetrieveFarClauseInput>;

/**
 * Normalize a user-supplied FAR code: trim and strip an optional
 * case-insensitive "FAR" prefix.
 *
 * @param raw - Validated input code.
 * @returns Bare clause code, for example "52.219-14".
 */
export function normalizeFarCode(raw: string): string {
  return raw.trim().replace(/^FAR\s+/i, "");
}
