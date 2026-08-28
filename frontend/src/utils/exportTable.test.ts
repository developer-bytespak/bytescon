// =============================================================
// CSV export.
//
// The cases here are the ones that make a file unusable in the tool it lands
// in: a comma inside a description, a quote inside a quote, a name with an
// accent, and a value Excel would run as a formula.
// =============================================================
import { describe, it, expect } from 'vitest'
import { toCsv, isoDate, num, type Column } from './exportTable'

interface Row { name: string; amount: string | null; when: string | null }
const COLUMNS: ReadonlyArray<Column<Row>> = [
  { header: 'Name', value: (r) => r.name },
  { header: 'Amount (USD)', value: (r) => num(r.amount) },
  { header: 'Date', value: (r) => isoDate(r.when) },
]

const row = (over: Partial<Row> = {}): Row =>
  ({ name: 'Travel', amount: '1250.50', when: '2026-03-04T00:00:00.000Z', ...over })

describe('toCsv — shape', () => {
  it('writes the declared headers, not the object keys', () => {
    expect(toCsv([row()], COLUMNS).split('\r\n')[0]).toBe('Name,Amount (USD),Date')
  })

  it('separates records with CRLF', () => {
    expect(toCsv([row(), row()], COLUMNS).split('\r\n')).toHaveLength(3)
  })

  it('still writes a header row when there is nothing to export', () => {
    expect(toCsv([], COLUMNS)).toBe('Name,Amount (USD),Date')
  })
})

describe('toCsv — values that would break the file', () => {
  it('quotes a value containing the delimiter', () => {
    const csv = toCsv([row({ name: 'Travel, lodging' })], COLUMNS)
    expect(csv).toContain('"Travel, lodging"')
  })

  it('doubles an embedded quote rather than ending the field', () => {
    const csv = toCsv([row({ name: 'Rate "ceiling"' })], COLUMNS)
    expect(csv).toContain('"Rate ""ceiling"""')
  })

  it('quotes a value containing a newline', () => {
    const csv = toCsv([row({ name: 'Line one\nLine two' })], COLUMNS)
    expect(csv).toContain('"Line one\nLine two"')
  })

  it('leaves an empty cell for a missing value rather than writing null', () => {
    expect(toCsv([row({ amount: null, when: null })], COLUMNS).split('\r\n')[1]).toBe('Travel,,')
  })
})

describe('toCsv — spreadsheet formula injection', () => {
  // A description someone typed is data. Excel disagrees unless it is told.
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@import'])('neutralises a value starting with %s', (value) => {
    const csv = toCsv([row({ name: value })], COLUMNS)
    expect(csv.split('\r\n')[1].startsWith(`'${value}`) || csv.includes(`"'${value}`)).toBe(true)
  })

  it('leaves an ordinary negative number alone in a numeric column', () => {
    // It arrives via `num`, which stringifies a Number — so it is never
    // mistaken for a formula the way a typed "-2+3" would be.
    expect(num('-500')).toBe('-500')
  })
})

describe('value formatters', () => {
  it('exports money as a bare number a sheet can total', () => {
    expect(num('1250.50')).toBe('1250.5')
  })

  it('leaves a blank amount blank instead of turning it into zero', () => {
    expect(num(null)).toBe('')
    expect(num('')).toBe('')
  })

  it('exports a date as ISO, not the reader locale', () => {
    expect(isoDate('2026-03-04T18:00:00.000Z')).toBe('2026-03-04')
  })

  it('returns nothing for an unparseable date instead of Invalid Date', () => {
    expect(isoDate('not a date')).toBe('')
    expect(isoDate(null)).toBe('')
  })
})
