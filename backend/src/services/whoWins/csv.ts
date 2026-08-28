// =============================================================
// Who-Wins — minimal RFC 4180 CSV parser.
//
// USAspending award-summary CSVs contain quoted fields with embedded
// commas, quotes ("" escaping), and newlines (recipient names, agency
// names). A dependency-free index scanner keeps memory to the input
// string + row objects and handles all three.
// =============================================================

/** Parse a CSV string into row objects keyed by the header row. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  let i = 0
  const n = text.length

  while (i < n) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\n' || ch === '\r') {
      // Handle \r\n, \n, and \r line endings; skip fully empty lines.
      row.push(field)
      field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
      if (ch === '\r' && text[i + 1] === '\n') i++
      i++
      continue
    }
    field += ch
    i++
  }
  // Trailing row without a final newline.
  row.push(field)
  if (row.length > 1 || row[0] !== '') rows.push(row)

  if (rows.length === 0) return []
  const header = rows[0]
  const out: Record<string, string>[] = []
  for (let r = 1; r < rows.length; r++) {
    const obj: Record<string, string> = {}
    for (let c = 0; c < header.length; c++) obj[header[c]] = rows[r][c] ?? ''
    out.push(obj)
  }
  return out
}
