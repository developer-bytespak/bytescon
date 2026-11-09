/**
 * Some notices have no real deadline (a grant forecast, or a rolling grant with
 * no closing date). They carry a placeholder date and this label, which is shown
 * in place of the date.
 */
export function deadlineLabelOf(opportunity: unknown): string | null {
  const meta = (opportunity as { sourceMetadata?: { deadlineLabel?: unknown } } | null)?.sourceMetadata
  return typeof meta?.deadlineLabel === 'string' && meta.deadlineLabel ? meta.deadlineLabel : null
}
