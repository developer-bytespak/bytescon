// =============================================================
// Opportunity ingestion classification helpers — pure + testable rules that
// keep data-quality decisions (manual-record protection, cancellation
// detection) in one place, shared by the SAM ingestion path.
// =============================================================

// Manual, firm-authored records (source=MANUAL) must never be overwritten by
// ingestion — the firm's edits are authoritative.
export function isManualProtected(source: string | null | undefined): boolean {
  return source === 'MANUAL'
}

// A SAM notice whose type indicates a cancellation marks the opportunity
// CANCELLED rather than leaving it silently ACTIVE.
export function isCancellationNotice(noticeType: string | null | undefined): boolean {
  return /cancel/i.test(noticeType ?? '')
}
