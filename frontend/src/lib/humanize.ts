// Status words as people read them. The API returns enum values such as
// NOT_EXERCISED or IN_REVIEW; the interface shows "Not exercised", "In review".
// Short acronyms (FFP, NDA, CDRL, SAM...) and words with lower-case letters are
// left as they are.
const KEEP = new Set(['FFP', 'NDA', 'IDIQ', 'BPA', 'CDRL', 'SAM', 'UEI', 'CAGE', 'NAICS', 'PSC', 'RFP', 'RFQ', 'RFI', 'SOW', 'PWS', 'GSA', 'DOD', 'VA', 'MOU', 'JV', 'CTA', 'MPA', 'AI', 'PDF', 'CSV', 'SB', 'WOSB', 'EDWOSB', 'SDVOSB', 'HUBZONE', '8A', 'T&M', 'CPFF', 'CPIF', 'FPI', 'BOA', 'OK'])

export function humanize(value: string | null | undefined): string {
  const s = (value ?? '').trim()
  if (!s || /[a-z]/.test(s) || !/^[A-Z0-9_ &-]+$/.test(s) || KEEP.has(s)) return s
  const words = s.replace(/_/g, ' ').toLowerCase().split(/\s+/)
  return words.map((w, i) => (KEEP.has(w.toUpperCase()) ? w.toUpperCase() : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ')
}
