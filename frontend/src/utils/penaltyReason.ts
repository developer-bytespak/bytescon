// Late-document penalties carry an internal "[doc-requirement:<id>]" marker in
// their reason (the backend uses it to avoid charging twice); hide it from users.
export function penaltyReasonText(reason: string | null | undefined): string {
  return (reason ?? '').replace(/\s*\[doc-requirement:[^\]]+\]\s*$/, '').trim()
}
