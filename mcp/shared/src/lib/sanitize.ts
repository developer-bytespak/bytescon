/**
 * Sanitization and response-cap helpers, extracted from opportunity-mcp
 * v0.3 (src/tools/search-opportunities.ts).
 *
 * sanitize(): prompt-injection mitigation per CLAUDE.md section 6.3. Tool
 * outputs are untrusted text from the database, treated as data and never
 * as instructions to the host LLM.
 *
 * capJsonResponse(): suite contract response caps, 8 KB default (warn)
 * and 32 KB hard (error), measured with Buffer.byteLength after
 * JSON.stringify.
 */
import type { Logger } from "./logger.js";

/** Per-field character cap applied by {@link sanitize} by default. */
export const SANITIZE_FIELD_CAP = 2000;

/** Suite default response cap in bytes (log a warning above this). */
export const MAX_RESPONSE_BYTES_DEFAULT = 8 * 1024;

/** Suite hard response cap in bytes (throw above this). */
export const MAX_RESPONSE_BYTES_HARD = 32 * 1024;

// Built at runtime to avoid embedding literal control bytes in source (git
// classifies files with NUL bytes as binary and refuses to diff them).
const CONTROL_CHARS_RE = new RegExp(
  "[" + String.fromCharCode(0) + "-" + String.fromCharCode(0x1f) + String.fromCharCode(0x7f) + "]",
  "g"
);

/**
 * Strip control characters (0x00-0x1F and 0x7F) and cap length.
 *
 * Control characters are replaced with spaces, not deleted, to preserve
 * word boundaries. Apply to every free-text field returned from the
 * database; never needed for ids, codes, URLs, or structured fields.
 *
 * @param text - Untrusted text, possibly null or undefined.
 * @param maxLength - Output character cap. Defaults to {@link SANITIZE_FIELD_CAP}.
 * @returns Sanitized text, or "" when input is null, undefined, or empty.
 */
export function sanitize(text: string | null | undefined, maxLength: number = SANITIZE_FIELD_CAP): string {
  if (!text) return "";
  return text.replace(CONTROL_CHARS_RE, " ").slice(0, maxLength);
}

/** Result of {@link capJsonResponse}: serialized text plus its UTF-8 byte size. */
export interface CappedJson {
  /** Pretty-printed JSON, ready to place in MCP text content. */
  text: string;
  /** Byte length of `text` in UTF-8, suitable for the audit `outputBytes` field. */
  outputBytes: number;
}

/** Options for {@link capJsonResponse}. */
export interface ResponseCapOptions {
  /** Soft cap in bytes; a warning is logged above this. Defaults to {@link MAX_RESPONSE_BYTES_DEFAULT}. */
  defaultCapBytes?: number | undefined;
  /** Hard cap in bytes; an Error is thrown above this. Defaults to {@link MAX_RESPONSE_BYTES_HARD}. */
  hardCapBytes?: number | undefined;
  /** Logger used for the soft-cap warning. When omitted no warning is logged. */
  logger?: Logger | undefined;
  /** Correlation id included in the soft-cap warning log line. */
  correlationId?: string | undefined;
}

/**
 * Serialize a tool payload to pretty JSON and enforce the suite response caps.
 *
 * Logs a warning above the default cap (when a logger is provided) and
 * throws above the hard cap so the calling tool handler converts it into
 * a structured `isError` response.
 *
 * @param payload - JSON-serializable tool result payload.
 * @param options - Cap sizes, logger, and correlation id. All optional.
 * @returns The serialized text and its byte count.
 * @throws Error when the serialized payload exceeds the hard cap.
 */
export function capJsonResponse(payload: unknown, options?: ResponseCapOptions): CappedJson {
  const defaultCap = options?.defaultCapBytes ?? MAX_RESPONSE_BYTES_DEFAULT;
  const hardCap = options?.hardCapBytes ?? MAX_RESPONSE_BYTES_HARD;

  const text = JSON.stringify(payload, null, 2);
  const outputBytes = Buffer.byteLength(text, "utf8");

  if (outputBytes > defaultCap && options?.logger) {
    options.logger.warn("response exceeds default cap", {
      correlation_id: options.correlationId,
      output_bytes: outputBytes,
      cap: defaultCap,
    });
  }
  if (outputBytes > hardCap) {
    throw new Error(
      `response of ${outputBytes} bytes exceeds hard cap ${hardCap}; reduce limit or add pagination`
    );
  }

  return { text, outputBytes };
}
