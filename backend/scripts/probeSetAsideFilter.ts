// Probe: does USAspending's type_set_aside filter actually filter?
// We send the same 4-code filter set the worker uses and inspect the top
// 5 recipient names + their reported award amounts. If the filter works,
// SDVOSBC results should be small-business primes, not Lockheed Martin.

import axios from 'axios'

const USA = 'https://api.usaspending.gov/api/v2/search/spending_by_award/'

const CODES = ['SDVOSBC', 'WOSB', '8A', 'HZC'] as const

async function probe(code: string) {
  const resp = await axios.post(
    USA,
    {
      filters: {
        time_period: [{ start_date: '2024-05-27', end_date: '2026-05-26' }],
        award_type_codes: ['A', 'B', 'C', 'D'],
        type_set_aside: [code],
      },
      fields: [
        'generated_internal_id',
        'Recipient Name',
        'Award Amount',
        'Awarding Agency',
      ],
      page: 1,
      limit: 5,
      sort: 'Award Amount',
      order: 'desc',
    },
    { timeout: 30000 },
  )

  const total = resp.data?.page_metadata?.total ?? -1
  const rows: any[] = resp.data?.results ?? []
  console.log(`\n=== ${code} (total available: ${total}) ===`)
  for (const r of rows) {
    console.log(
      `  $${Number(r['Award Amount']).toLocaleString().padEnd(20)} ${r['Recipient Name']}  [${r['Awarding Agency']}]`,
    )
  }
}

async function probeWithoutFilter() {
  const resp = await axios.post(
    USA,
    {
      filters: {
        time_period: [{ start_date: '2024-05-27', end_date: '2026-05-26' }],
        award_type_codes: ['A', 'B', 'C', 'D'],
      },
      fields: ['Recipient Name', 'Award Amount', 'Awarding Agency'],
      page: 1,
      limit: 5,
      sort: 'Award Amount',
      order: 'desc',
    },
    { timeout: 30000 },
  )
  const total = resp.data?.page_metadata?.total ?? -1
  const rows: any[] = resp.data?.results ?? []
  console.log(`\n=== NO SET-ASIDE FILTER (total available: ${total}) ===`)
  for (const r of rows) {
    console.log(
      `  $${Number(r['Award Amount']).toLocaleString().padEnd(20)} ${r['Recipient Name']}  [${r['Awarding Agency']}]`,
    )
  }
}

async function main() {
  await probeWithoutFilter()
  for (const code of CODES) {
    await probe(code)
  }
}

main().catch((err) => {
  console.error('Probe failed:', (err as Error).message)
  process.exitCode = 1
})
