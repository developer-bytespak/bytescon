/**
 * Normalize a user-supplied website URL for safe use as an <a href>.
 *
 * Why: many SAM/UEI imports store websites as bare domains
 * ("example.com"). Without a scheme, the browser treats the value as a
 * relative path and the link breaks. This helper prepends `https://`
 * when no protocol is present, trims whitespace, and returns an empty
 * string for null/empty input so callers can render a fallback like '—'.
 */
export function normalizeUrl(url: string | null | undefined): string {
  if (!url) return ''
  const trimmed = url.trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}
