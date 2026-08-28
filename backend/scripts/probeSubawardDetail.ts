import axios from 'axios'

const BASE = 'https://api.usaspending.gov/api/v2'

const SUBAWARD_ID = process.argv[2] || '1660707'

async function tryEndpoint(path: string) {
  console.log(`\n--- GET ${path} ---`)
  try {
    const resp = await axios.get(`${BASE}${path}`, { timeout: 20_000 })
    console.log('Status:', resp.status)
    console.log('Keys:', Object.keys(resp.data || {}).slice(0, 30).join(', '))
    console.log('Body (truncated):', JSON.stringify(resp.data, null, 2).slice(0, 1500))
  } catch (err: any) {
    console.log('FAILED:', err.response?.status ?? err.message)
  }
}

async function main() {
  // Try several plausible variants
  await tryEndpoint(`/subaward/${SUBAWARD_ID}/`)
  await tryEndpoint(`/subawards/${SUBAWARD_ID}/`)
  await tryEndpoint(`/sub_award/${SUBAWARD_ID}/`)
  await tryEndpoint(`/recipient/duns/`)  // probe for a separate recipient detail endpoint
}

main().catch((e) => { console.error(e.message); process.exitCode = 1 })
