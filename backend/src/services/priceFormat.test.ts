// Price formats: detection from real solicitation wording, reading items, and the "priced" rule.
import { describe, it, expect } from 'vitest'
import { detectPriceFormats, parseItems, lineItemsPriced, wrapFactor, priceFormatOf } from './priceFormat'

const formats = (noticeType: string | null, ...texts: string[]) => detectPriceFormats({ noticeType, texts }).map((m) => m.format)

describe('detectPriceFormats', () => {
  it('reads a schedule of items (SF-1449 blocks 19-24, unit price, CLINs) as line items', () => {
    expect(formats('Solicitation', '19. ITEM NUMBER 20. SCHEDULE OF SUPPLIES/SERVICES 21. QUANTITY 22. UNIT 23. UNIT PRICE 24. AMOUNT')).toEqual(['LINE_ITEMS'])
    expect(formats('Combined Synopsis/Solicitation', 'See attached.')).toEqual(['LINE_ITEMS'])
  })
  it('a cost-reimbursement solicitation that asks for the cost elements needs the cost breakdown', () => {
    expect(formats('Solicitation', 'This is a cost-plus-fixed-fee contract. Proposals shall include a cost breakdown; cost realism will be evaluated. CLIN 0001.')).toEqual(['COST_BREAKDOWN', 'LINE_ITEMS'])
    expect(formats('Solicitation', 'The detailed offer breakdown must clearly identify all costs. The pricing offer must also include a total amount for all CLINs.')).toEqual(['COST_BREAKDOWN', 'LINE_ITEMS'])
  })
  it('asks for labor rates only when the pricing asks for rates, not when a clause names time-and-materials', () => {
    expect(formats('Solicitation', 'Offerors shall propose fully burdened hourly rates for each labor category.')).toEqual(['LABOR_RATES'])
    expect(formats('Solicitation', '52.212-4 Alternate I applies to time-and-materials and labor-hour contracts. 23. UNIT PRICE')).toEqual(['LINE_ITEMS'])
  })
  it('no price for a Sources Sought, and nothing found otherwise', () => {
    expect(formats('Sources Sought', 'unit price')).toEqual(['NONE'])
    expect(formats('Award Notice', 'Awarded.')).toEqual([])
    expect(priceFormatOf(null, [])).toBe('LINE_ITEMS')
    expect(priceFormatOf('LABOR_RATES', [{ format: 'LINE_ITEMS', reason: '' }])).toBe('LABOR_RATES')
  })
})

describe('parseItems', () => {
  it('keeps the items the AI read, with sane defaults, and drops junk', () => {
    const raw = 'Here you go: [{"itemNumber":"0001","description":"Mobile Phone Services","quantity":12,"unit":"MO","period":"Base Year"},{"itemNumber":"0002","description":"","quantity":1},{"description":"Spare part","quantity":"x"}]'
    expect(parseItems(raw)).toEqual([
      { itemNumber: '0001', description: 'Mobile Phone Services', quantity: 12, unit: 'MO', period: 'Base Year' },
      { itemNumber: '—', description: 'Spare part', quantity: 1, unit: 'EA', period: null },
    ])
    expect(parseItems('no json here')).toEqual([])
  })
})

describe('pricing rules', () => {
  it('a line-item price is built once every item has a unit price', () => {
    expect(lineItemsPriced([])).toBe(false)
    expect(lineItemsPriced([{ unitPrice: 10 }, { unitPrice: null }])).toBe(false)
    expect(lineItemsPriced([{ unitPrice: 10 }, { unitPrice: 0 }])).toBe(true)
  })
  it('the labor wrap covers fringe, overhead, G&A and fee, not other direct costs', () => {
    // 100 direct labor + 50 indirect + 20 ODC = 170 before fee, + 15 fee: (170 + 15 - 20) / 100
    expect(wrapFactor({ totalDirectLabor: 100, subtotalBeforeFee: 170, totalFee: 15, totalOdc: 20, totalSubcontractor: 0 })).toBeCloseTo(1.65)
    expect(wrapFactor({ totalDirectLabor: 0, subtotalBeforeFee: 0, totalFee: 0, totalOdc: 0, totalSubcontractor: 0 })).toBe(1)
  })
})
