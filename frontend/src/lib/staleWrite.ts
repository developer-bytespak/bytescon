import type { AxiosError } from 'axios'

// Shared F4 helper: detect an optimistic-lock rejection (409 STALE_WRITE) from
// a failed mutation so pages can prompt the user to reload rather than showing
// a generic error. The backend also returns `currentUpdatedAt` for reconciling.
interface StaleWriteBody {
  code?: string
  error?: string
  currentUpdatedAt?: string
}

export function isStaleWrite(err: unknown): boolean {
  const e = err as AxiosError<StaleWriteBody>
  return e?.response?.status === 409 && e.response?.data?.code === 'STALE_WRITE'
}

/**
 * Returns the reload-to-see-latest message when `err` is a stale write,
 * otherwise null (so callers can fall through to their generic handler).
 */
export function staleWriteMessage(err: unknown): string | null {
  if (!isStaleWrite(err)) return null
  const e = err as AxiosError<StaleWriteBody>
  return (
    e.response?.data?.error ||
    'This record has been changed by someone else — reload to see latest'
  )
}

export function staleWriteCurrentUpdatedAt(err: unknown): string | null {
  const e = err as AxiosError<StaleWriteBody>
  return e?.response?.data?.currentUpdatedAt ?? null
}
