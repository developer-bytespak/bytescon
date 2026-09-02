/**
 * `list_users` tool handler.
 *
 * The tenant's platform users: first name, last name, role, active flag,
 * last login. PRIVACY: email addresses are excluded by default and only
 * included when include_emails is true AND the token tier is PRO or
 * higher (defense in depth; the whole server already requires PRO).
 * passwordHash and verification fields are never selected.
 */
import {
  registerTool,
  requireTier,
  sanitize,
  type HandlerResult,
  type ToolHandlerContext,
  type ToolRegistrar,
} from "@bytescon/mcp-shared";
import { coreDb } from "../lib/db.js";
import { runTool } from "../lib/run-tool.js";
import {
  listUsersInputShape,
  type ListUsersInputT,
  type ListUsersPayload,
  type UserSummary,
} from "../schemas/list-users.js";

const TOOL_NAME = "list_users";

const TOOL_DESCRIPTION =
  "List your tenant's platform users with first name, last name, role, active flag, and last login. " +
  "Email addresses are excluded by default for privacy; set include_emails to true (requires token tier PRO or higher) to include them. " +
  "Paginated with offset and limit.";

/**
 * Pure handler, directly testable. The McpServer registration wraps this.
 */
export async function handleListUsers(
  input: ListUsersInputT,
  context: ToolHandlerContext
): Promise<HandlerResult> {
  return runTool(TOOL_NAME, input, context, async () => {
    // include_emails is additionally tier-gated (PRO+). The runTool
    // wrapper already enforces the server-wide PRO gate; this explicit
    // check keeps the flag safe even if the server gate ever changes.
    if (input.include_emails) {
      requireTier(context.ctx, "PRO");
    }

    const db = coreDb(context.prisma);

    const where: Record<string, unknown> = {
      consultingFirmId: context.ctx.consultingFirmId,
    };

    const select: Record<string, boolean> = {
      id: true,
      firstName: true,
      lastName: true,
      role: true,
      isActive: true,
      lastLoginAt: true,
    };
    if (input.include_emails) select["email"] = true;

    const [total, rows] = await Promise.all([
      db.user.count({ where }),
      db.user.findMany({
        where,
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
        skip: input.offset,
        take: input.limit,
        select,
      }),
    ]);

    const results: UserSummary[] = rows.map((u) => ({
      id: u.id,
      first_name: sanitize(u.firstName, 200),
      last_name: sanitize(u.lastName, 200),
      role: sanitize(u.role, 100),
      is_active: u.isActive,
      last_login_at: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
      ...(input.include_emails ? { email: sanitize(u.email, 320) } : {}),
    }));

    const payload: ListUsersPayload = {
      count: results.length,
      total,
      offset: input.offset,
      limit: input.limit,
      results,
    };
    return payload;
  });
}

export const registerListUsers: ToolRegistrar = (server, context) => {
  registerTool(server, {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputShape: listUsersInputShape,
    handler: async (input) => handleListUsers(input as unknown as ListUsersInputT, context),
  });
};
