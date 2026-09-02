/**
 * Input schema for `list_set_asides`.
 *
 * Returns the canonical public set-aside enum values together with a
 * live count of OPEN (status ACTIVE) opportunities per value for the
 * calling tenant. Cheap aggregate, one groupBy query.
 */
import { z } from "zod";

export const listSetAsidesInputShape = {
  include_zero_counts: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Include canonical set-aside values that currently have zero open opportunities. Default true."
    ),
};

export const ListSetAsidesInput = z.object(listSetAsidesInputShape);
export type ListSetAsidesInputT = z.infer<typeof ListSetAsidesInput>;

export interface SetAsideCountRow {
  /** Canonical public enum value (matches the `set_aside` filter on search_opportunities). */
  set_aside: string;
  /** Value as stored in the opportunities table (free-text column). */
  stored_value: string;
  /** Count of the tenant's ACTIVE opportunities carrying this set-aside. */
  open_count: number;
}

export interface ListSetAsidesPayload {
  count: number;
  results: SetAsideCountRow[];
  /** Stored values found in the tenant's open pool that do not map to a canonical enum value. */
  other: Array<{ stored_value: string; open_count: number }>;
  generated_at: string;
}
