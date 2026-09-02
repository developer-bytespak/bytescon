/**
 * Raw node:http helpers for the gateway integration tests.
 *
 * Uses node:http (not fetch) so SSE responses from the MCP Streamable HTTP
 * transport can be read with a soft timeout, and 302 Location headers stay
 * visible (fetch's redirect:"manual" hides them).
 */
import http from "node:http";

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

export interface RawOptions {
  headers?: Record<string, string>;
  body?: string;
  /** Resolve after this many ms even if the response stream stays open (SSE). */
  softTimeoutMs?: number;
}

export function rawRequest(port: number, method: string, path: string, opts: RawOptions = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (r: RawResponse): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: opts.headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      let timer: NodeJS.Timeout | undefined;
      if (opts.softTimeoutMs) {
        timer = setTimeout(() => {
          finish({ status: res.statusCode ?? 0, headers: res.headers, text: data });
          req.destroy();
        }, opts.softTimeoutMs);
      }
      res.on("data", (chunk: string) => {
        data += chunk;
      });
      res.on("end", () => {
        if (timer) clearTimeout(timer);
        finish({ status: res.statusCode ?? 0, headers: res.headers, text: data });
      });
    });
    req.on("error", (err) => {
      if (!settled) reject(err);
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/**
 * Parse the JSON-RPC payload out of an MCP Streamable HTTP response body. The
 * transport replies as Server-Sent Events (`event: message\ndata: {json}`); a
 * plain JSON body is also accepted as a fallback.
 */
export function parseMcpBody(text: string): Record<string, unknown> {
  const dataLine = text
    .split(/\r?\n/)
    .find((line) => line.startsWith("data:"));
  const json = dataLine ? dataLine.slice("data:".length).trim() : text.trim();
  return JSON.parse(json) as Record<string, unknown>;
}

export const JSON_MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
