// =============================================================
// CSV writing.
//
// Server-side exports had each grown their own escaping, none of which guarded
// against a value the recipient's spreadsheet would execute. These pin the
// rules so the next export cannot quietly reintroduce a weaker one.
// =============================================================
import { describe, it, expect } from 'vitest'
import { csvCell, csvRows, csvBody, CSV_BOM } from './csv'

describe('csvCell', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvCell('SOC Analyst II')).toBe('SOC Analyst II')
  })

  it('quotes a value containing the delimiter', () => {
    expect(csvCell('Travel, lodging')).toBe('"Travel, lodging"')
  })

  it('doubles an embedded quote rather than ending the field', () => {
    expect(csvCell('Rate "ceiling"')).toBe('"Rate ""ceiling"""')
  })

  it('quotes a value containing a newline', () => {
    expect(csvCell('one\ntwo')).toBe('"one\ntwo"')
  })

  it('writes an empty cell for null and undefined, not the word', () => {
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  it('keeps a zero, which is a figure and not an absence', () => {
    expect(csvCell(0)).toBe('0')
  })

  it.each(['=1+1', '+SUM(A1)', '-2+3', '@import'])('neutralises %s so a sheet cannot run it', (v) => {
    expect(csvCell(v)).toBe(`'${v}`)
  })
})

describe('csvRows', () => {
  it('separates records with CRLF', () => {
    expect(csvRows([['a', 'b'], ['c', 'd']])).toBe('a,b\r\nc,d')
  })
})

describe('csvBody', () => {
  it('leads with the BOM so Excel reads it as UTF-8', () => {
    expect(csvBody([['Agency']])).toBe(`${CSV_BOM}Agency`)
  })

  it('uses the real byte-order-mark character', () => {
    expect(CSV_BOM).toBe('﻿')
    expect(Buffer.from(CSV_BOM, 'utf8')).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
  })
})
