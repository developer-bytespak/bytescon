/**
 * Structured logger for opportunity-mcp.
 *
 * Uses Winston (matches the backend's logging stack) configured to emit
 * JSON exclusively to stderr. In stdio MCP mode the process's stdout is
 * the MCP protocol transport — writing logs to stdout corrupts the
 * protocol stream. stderrLevels forces every level through stderr.
 *
 * Required fields per CLAUDE.md §5.3: timestamp, level, service,
 * tenant_id (when applicable), correlation_id, message.
 */
import winston from "winston";

const ALL_LEVELS = ["error", "warn", "info", "http", "verbose", "debug", "silly"];

const baseFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

export const logger = winston.createLogger({
  level: process.env.MCP_LOG_LEVEL ?? "info",
  defaultMeta: { service: "opportunity-mcp" },
  format: baseFormat,
  transports: [
    new winston.transports.Console({ stderrLevels: ALL_LEVELS }),
  ],
});

export default logger;
