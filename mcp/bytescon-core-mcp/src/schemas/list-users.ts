/**
 * Input schema for the `list_users` tool.
 *
 * Lists the tenant's platform users. Email addresses are EXCLUDED by
 * default (privacy); the include_emails flag is gated to tier PRO or
 * higher (defense in depth, the whole server already requires PRO).
 */
import { z } from "zod";

export const listUsersInputShape = {
  include_emails: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, include each user's email address. Requires token tier PRO or higher. Default false."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(25)
    .describe("Maximum rows to return, 1-100, default 25."),
  offset: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .optional()
    .default(0)
    .describe("Rows to skip for pagination, default 0."),
};

export const ListUsersInput = z.object(listUsersInputShape);
export type ListUsersInputT = z.infer<typeof ListUsersInput>;

export interface UserSummary {
  id: string;
  first_name: string;
  last_name: string;
  role: string;
  is_active: boolean;
  last_login_at: string | null;
  /** Present only when include_emails is true and the tier gate passes. */
  email?: string;
}

export interface ListUsersPayload {
  count: number;
  total: number;
  offset: number;
  limit: number;
  results: UserSummary[];
}
