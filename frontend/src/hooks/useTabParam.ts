import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * Keeps the active tab in the URL as `?tab=`, so a refresh, a bookmark or a
 * shared link lands on the tab the person was actually looking at.
 *
 * The URL is the single source of truth rather than a mirrored `useState`,
 * which is what makes browser back/forward and a pasted link agree with the
 * rendered tab instead of drifting from it.
 *
 * An unknown or missing value falls back rather than rendering nothing, so a
 * hand-edited or stale link can never leave the page blank.
 */
export function useTabParam<T extends string>(
  keys: readonly T[],
  fallback: T,
  paramName = 'tab',
): [T, (next: T) => void] {
  const [params, setParams] = useSearchParams()

  const raw = params.get(paramName)
  const active = keys.includes(raw as T) ? (raw as T) : fallback

  const setTab = useCallback((next: T) => {
    const updated = new URLSearchParams(params)
    updated.set(paramName, next)
    // Replaced, not pushed: a tab is which part of this page you are looking
    // at, so Back should leave the page rather than walk every tab you tried.
    setParams(updated, { replace: true })
  }, [params, setParams, paramName])

  return [active, setTab]
}
