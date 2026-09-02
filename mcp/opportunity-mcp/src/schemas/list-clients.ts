/**
 * Input schema for the `list_clients` tool.
 *
 * Returns the calling tenant's active client companies — small-business
 * federal contractors the firm represents. Tenant-scoped.
 */
import { z } from "zod";

export const listClientsInputShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(25)
    .describe("Maximum number of clients to return. 1-100, default 25."),
  include_inactive: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, include archived/inactive clients. Default false."),
};

export const ListClientsInput = z.object(listClientsInputShape);
export type ListClientsInputT = z.infer<typeof ListClientsInput>;

export interface ClientSummary {
  id: string;
  name: string;
  uei: string | null;
  cage: string | null;
  naics_codes: string[];
  certifications: {
    sdvosb: boolean;
    wosb: boolean;
    hubzone: boolean;
    small_business: boolean;
  };
  is_active: boolean;
  performance: {
    total_opportunities: number;
    total_submitted: number;
    total_won: number;
    total_lost: number;
    completion_rate: number;
  } | null;
}

export interface ClientListPayload {
  count: number;
  results: ClientSummary[];
}
