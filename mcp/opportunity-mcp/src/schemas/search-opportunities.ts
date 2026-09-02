/**
 * Input schema for the `search_opportunities` tool.
 *
 * The McpServer.tool() registration accepts a Zod raw shape, not a full
 * ZodObject. We export both: the raw shape for SDK registration and the
 * composed object for direct validation in tests.
 */
import { z } from "zod";

export const SetAsideEnum = z.enum([
  "SDVOSB",
  "VOSB",
  "8A",
  "WOSB",
  "HUBZONE",
  "TOTAL_SMALL_BUSINESS",
  "UNRESTRICTED",
]);

export type SetAside = z.infer<typeof SetAsideEnum>;

/**
 * The public `set_aside` enum values do not all match the `setAsideType`
 * strings stored on `opportunities` (a free-text String column, not a DB
 * enum). Translate the public value to the stored value at the query
 * boundary so the public tool contract stays stable while filters actually
 * match data. Identity entries are explicit so the full mapping is auditable
 * in one place.
 *
 * Stored values observed in production: SDVOSB, WOSB, HUBZONE, SBA_8A,
 * SMALL_BUSINESS, NONE (UNRESTRICTED / full-and-open is stored as NONE).
 */
export const SET_ASIDE_DB_VALUE: Record<SetAside, string> = {
  SDVOSB: "SDVOSB",
  VOSB: "VOSB",
  "8A": "SBA_8A",
  WOSB: "WOSB",
  HUBZONE: "HUBZONE",
  TOTAL_SMALL_BUSINESS: "SMALL_BUSINESS",
  UNRESTRICTED: "NONE",
};

export const searchOpportunitiesInputShape = {
  keyword: z
    .string()
    .min(1)
    .max(200)
    .describe("Free-text search term matched against title, description, and agency (case-insensitive)."),
  naics: z
    .string()
    .regex(/^\d{6}$/, "naics must be exactly 6 digits")
    .optional()
    .describe("Exact 6-digit NAICS code filter."),
  set_aside: SetAsideEnum.optional().describe(
    "Set-aside type filter. Use UNRESTRICTED for full-and-open."
  ),
  posted_after: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe("ISO 8601 datetime with offset; returns only opportunities posted on or after this instant."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Maximum results to return, 1-50, default 10."),
  cursor: z
    .string()
    .max(512)
    .optional()
    .describe(
      "Opaque pagination cursor. Pass `next_cursor` from the previous response to fetch the next page. " +
      "Cursor is keyset-based on (response_deadline, id), so it is stable under concurrent inserts. " +
      "Omit on the first call."
    ),
};

export const SearchOpportunitiesInput = z.object(searchOpportunitiesInputShape);

export type SearchOpportunitiesInputT = z.infer<typeof SearchOpportunitiesInput>;

export interface SearchOpportunityResult {
  id: string;
  title: string;
  agency: string;
  naics: string;
  set_aside: string;
  posted_date: string | null;
  response_deadline: string;
  score: number;
  url: string | null;
}

export interface SearchOpportunitiesPayload {
  count: number;
  results: SearchOpportunityResult[];
  /** Opaque cursor for the next page. Null when no more results.
   * Callers should pass this value back as `cursor` to continue. */
  next_cursor: string | null;
}
