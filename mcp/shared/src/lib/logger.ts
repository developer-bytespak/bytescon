/**
 * Winston stderr logger factory for Bytescon MCP servers.
 *
 * Extracted from opportunity-mcp v0.3 (src/lib/logger.ts), parameterized
 * on the service name. JSON output exclusively to stderr: in stdio MCP
 * mode the process stdout is the MCP protocol transport, so writing logs
 * to stdout corrupts the protocol stream. `stderrLevels` forces every
 * level through stderr.
 *
 * Required fields per CLAUDE.md section 5.3: timestamp, level, service,
 * tenant_id (when applicable), correlation_id, message. timestamp, level,
 * and service are emitted automatically; callers supply the rest as meta.
 */
import winston from "winston";

/** Re-exported so consumers can type logger parameters without importing winston. */
export type Logger = winston.Logger;

const ALL_LEVELS = ["error", "warn", "info", "http", "verbose", "debug", "silly"];

/**
 * Create a structured JSON logger that writes every level to stderr.
 *
 * @param serviceName - Emitted as the `service` field on every log line
 *   (for example "knowledge-mcp").
 * @param level - Minimum level. Defaults to MCP_LOG_LEVEL env var, then "info".
 * @returns A configured winston Logger.
 */
export function createStderrLogger(serviceName: string, level?: string): Logger {
  return winston.createLogger({
    level: level ?? process.env.MCP_LOG_LEVEL ?? "info",
    defaultMeta: { service: serviceName },
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    transports: [new winston.transports.Console({ stderrLevels: ALL_LEVELS })],
  });
}
