// =============================================================
// CSV writing.
//
// The escaping rule was already written out by hand in more than one route,
// each copy slightly different and none of them guarding against the one thing
// that makes an exported file dangerous rather than merely untidy: a value the
// recipient's spreadsheet decides to execute.
//
// Mirrors `frontend/src/utils/exportTable.ts` deliberately. A file exported
// from the server and one exported from the browser should not differ in how
// they quote, or the same data opens two different ways.
// =============================================================

/**
 * Excel reads a leading =, +, - or @ as a formula. A vendor name or a
 * description someone typed is data, so it is prefixed with an apostrophe —
 * visible in the cell, inert as a formula.
 */
function neutralise(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
}

/** RFC 4180: quote when the value contains a delimiter, quote or newline. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = neutralise(String(value))
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function csvRows(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  // CRLF per RFC 4180 — some Windows tooling still treats a bare LF as one line.
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
}

/**
 * The BOM is what makes Excel read the file as UTF-8. Without it an agency name
 * with an accent in it arrives mangled, which is most of them eventually.
 */
export const CSV_BOM = '\uFEFF'

export function csvBody(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return CSV_BOM + csvRows(rows)
}
