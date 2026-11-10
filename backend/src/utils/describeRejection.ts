/**
 * What to log for an unhandled rejection. An Error serialises to {} in JSON
 * logs, which is why these lines used to show `"reason":{}`.
 */
export function describeRejection(reason: unknown): { reason: string; name?: string; code?: unknown; stack?: string } {
  if (reason instanceof Error) {
    const code = (reason as Error & { code?: unknown }).code
    return { reason: reason.message || '(no message)', name: reason.name, ...(code !== undefined ? { code } : {}), stack: reason.stack?.split('\n').slice(0, 8).join('\n') }
  }
  if (typeof reason === 'string') return { reason }
  try {
    return { reason: JSON.stringify(reason) ?? String(reason) }
  } catch {
    return { reason: String(reason) }
  }
}
