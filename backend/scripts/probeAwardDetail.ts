import axios from 'axios'

const BASE = 'https://api.usaspending.gov/api/v2'
// Use one of the top-obligation awards from our corpus
const ID = process.argv[2] || 'CONT_AWD_HQ0034T1700001_9700_-NONE-_-NONE-'

async function main() {
  const url = `${BASE}/awards/${encodeURIComponent(ID)}/`
  console.log('GET', url)
  try {
    const resp = await axios.get(url, { timeout: 30_000 })
    console.log('Status:', resp.status)
    const d = resp.data
    console.log('Top-level keys:', Object.keys(d).slice(0, 30).join(', '))
    console.log('\nrecipient keys:', Object.keys(d.recipient ?? {}).join(', '))
    console.log('recipient_uei:', d.recipient?.recipient_uei ?? d.recipient_uei)
    console.log('parent_uei:', d.recipient?.parent_recipient_uei)
    console.log('latest_transaction.contract_data set_aside:', d.latest_transaction?.contract_data?.type_set_aside)
    console.log('extent_competed:', d.latest_transaction?.contract_data?.extent_competed)
    console.log('\nFirst 1500 chars of body:')
    console.log(JSON.stringify(d, null, 2).slice(0, 1500))
  } catch (err: any) {
    console.log('FAILED')
    console.log('Code:', err.code, 'Status:', err.response?.status)
    console.log('Message:', err.message)
    if (err.response?.data) console.log('Body:', JSON.stringify(err.response.data).slice(0, 300))
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
