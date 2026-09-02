/**
 * Input schema for the `search_clauses` tool.
 *
 * Keyword search via ILIKE across code, title, summary, and text on both
 * clause tables. This deliberately replaces the spec's semantic_search:
 * there is no embedding infrastructure in v0.1 (see README downscope note).
 */
import { z } from "zod";

export const ClauseSourceEnum = z.enum(["FAR", "DFARS"]);
export type ClauseSourceT = z.infer<typeof ClauseSourceEnum>;

export const searchClausesInputShape = {
  keyword: z
    .string()
    .min(2)
    .max(100)
    .describe(
      "Free-text keyword matched case-insensitively against clause code, title, summary, and text."
    ),
  source: ClauseSourceEnum.optional().describe(
    "Restrict the search to one regulation set: FAR or DFARS. Omit to search both."
  ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .default(10)
    .describe("Maximum results to return, 1-25, default 10."),
};

export const SearchClausesInput = z.object(searchClausesInputShape);
export type SearchClausesInputT = z.infer<typeof SearchClausesInput>;
