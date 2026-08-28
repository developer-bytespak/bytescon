// Probe: what does /api/v2/subawards/ actually return per row?
// Pick one prime that we know yielded subawards in the last refresh.

import axios from 'axios'

const USA = 'https://api.usaspending.gov/api/v2/subawards/'

// Pick a prime where the last refresh succeeded; using the JOIN-check sample
// from the refresh log: CONT_AWD_DENA0001942_8900_-NONE-_-NONE-
// Fall back to any well-known DoD contract id.
const PRIME = process.argv[2] || 'CONT_AWD_HR001120F0001_9700_HR001120D0001_9700'

async function main() {
  const resp = await axios.post(
    USA,
    { award_id: PRIME, page: 1, limit: 3 },
    { timeout: 30_000 },
  )

  console.log('--- META ---')
  console.log(JSON.stringify(resp.data?.page_metadata ?? {}, null, 2))

  const rows: any[] = resp.data?.results ?? []
  console.log(`\n--- ${rows.length} ROWS for prime ${PRIME} ---`)
  for (const r of rows) {
    console.log('\n>>> ROW:')
    console.log(JSON.stringify(r, null, 2))
  }
}

main().catch((err: any) => {
  console.error('Probe failed:', err.message)
  if (err.response) {
    console.error('HTTP', err.response.status, JSON.stringify(err.response.data).slice(0, 500))
  }
  process.exitCode = 1
})
