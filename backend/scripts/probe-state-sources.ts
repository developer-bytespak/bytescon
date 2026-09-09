// =============================================================
// Dev tool: probe each state procurement source used by the State &
// Municipal sync and report how many rows it returns today.
//   npx ts-node --transpile-only scripts/probe-state-sources.ts
// Public sources only; portals that need credentials are tried without
// them so you can see which ones fail closed.
// =============================================================
import * as s from '../src/services/stateProcurementScraper'

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))])

const SOURCES: Array<[string, () => Promise<s.StateOpportunityRecord[]>]> = [
  ['NY NYSCR', () => s.scrapeNYSCR(1)],
  ['TX ESBD', () => s.scrapeTXESBD(1)],
  ['FL VBS', () => s.scrapeFLVBS(1)],
  ['VA eVA', () => s.scrapeVAeVA()],
  ['GA GPR', () => s.scrapeGAGPR(1)],
  ['NC eProcurement', () => s.scrapeNCIPS(1)],
  ['OH Procure', () => s.scrapeOHProcurement(1)],
  ['IL BidBuy', () => s.scrapeILBidBuy(1)],
  ['CA eProcure', () => s.scrapeCAeProcure(1)],
  ['MD eMMA (no creds)', () => s.scrapeMDEmma()],
  ['PA eMarketplace (no creds)', () => s.scrapePAeMarketplace()],
  ['USAspending (3 states)', () => s.scrapeUSAspendingContracts(s.TOP_20_STATES.slice(0, 3))],
]

async function main() {
  for (const [name, fn] of SOURCES) {
    const t0 = Date.now()
    try {
      const rows = await withTimeout(fn(), 45_000)
      const sample = rows[0] ? `  e.g. "${String(rows[0].title).slice(0, 48)}" · ${rows[0].agency}` : ''
      console.log(`${name.padEnd(28)} ${String(rows.length).padStart(4)} rows  ${String(Date.now() - t0).padStart(6)}ms${sample}`)
    } catch (e) {
      console.log(`${name.padEnd(28)} FAIL       ${String(Date.now() - t0).padStart(6)}ms  ${String((e as Error).message).slice(0, 90)}`)
    }
  }
}

main().then(() => process.exit(0))
