// New York's Contract Reporter pages with ?Skip=, not ?Page= (which it ignores).
import { describe, it, expect, vi } from 'vitest'
import axios from 'axios'
import { scrapeNYSCR } from './stateProcurementScraper'

const ad = (id: number) => `<div class="opp-list-item" data-ad-id="${id}" title="Full Title: Bid ${id}"><span>Agency:</span> NYS DOT</div>`
const page = (from: number, n: number) => `<main>${Array.from({ length: n }, (_, i) => ad(from + i)).join('')}</main>`

describe('scrapeNYSCR', () => {
  it('moves through results with Skip, and stops after a short page', async () => {
    const urls: string[] = []
    const get = vi.fn(async (url: string) => {
      urls.push(url)
      const skip = Number(/Skip=(\d+)/.exec(url)?.[1] ?? '0')
      return { data: page(skip, skip === 25 ? 10 : 25) }
    })
    vi.spyOn(axios, 'create').mockReturnValue({ get } as never)
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const run = scrapeNYSCR(4)
    await vi.runAllTimersAsync()
    const rows = await run
    vi.useRealTimers()
    expect(urls).toEqual(['https://www.nyscr.ny.gov/Ads/Search?Skip=0', 'https://www.nyscr.ny.gov/Ads/Search?Skip=25'])
    expect(rows).toHaveLength(35)
    expect(new Set(rows.map((r) => r.title)).size).toBe(35)
  })
})
