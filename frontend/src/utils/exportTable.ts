// =============================================================
// Tabular CSV export.
//
// `useExportCsv` takes whatever object it is handed and uses its keys as
// headers. That is fine for a flat row already shaped for a person, but an API
// row is not: it carries `id` and `consultingFirmId` nobody wants, renders a
// nested `{ clin: { clinNumber } }` as "[object Object]", and gives columns
// names like `incurredDate` instead of "Incurred date".
//
// So a caller here declares its columns. It is a few more lines at the call
// site and it is the difference between a file someone can open and one they
// have to clean up first.
// =============================================================

export interface Column<T> {
  header: string
  value: (row: T) => string | number | null | undefined
}

/**
 * Excel reads a leading =, +, - or @ as a formula. A description someone typed
 * is data, so it is prefixed with an apostrophe — visible in the cell, inert as
 * a formula. Without this an exported field is an execution vector in the
 * recipient's spreadsheet.
 */
function neutralise(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
}

/** RFC 4180: quote when the value contains a delimiter, quote or newline. */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const s = neutralise(String(value))
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv<T>(rows: readonly T[], columns: ReadonlyArray<Column<T>>): string {
  const head = columns.map((c) => cell(c.header)).join(',')
  const body = rows.map((r) => columns.map((c) => cell(c.value(r))).join(','))
  // CRLF per RFC 4180 — some Windows tooling still treats a bare LF as one line.
  return [head, ...body].join('\r\n')
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function downloadCsv<T>(
  rows: readonly T[],
  columns: ReadonlyArray<Column<T>>,
  filename: string,
): void {
  // The BOM is what makes Excel read the file as UTF-8. Without it an agency
  // name with an accent in it arrives mangled.
  const blob = new Blob(['\uFEFF', toCsv(rows, columns)], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename}-${today()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

/** Money as a bare number: a spreadsheet should sum it, not read "$1,234.00". */
export const num = (v: unknown): string => (v == null || v === '' ? '' : String(Number(v)))

/** ISO date, which every spreadsheet and billing system parses the same way. */
export const isoDate = (v: unknown): string => {
  if (!v) return ''
  const d = new Date(v as string)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}
