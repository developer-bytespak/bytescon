// =============================================================
// Generator: data-sources/prime-sblo-directory.csv
//            -> src/data/primeSbloDirectory.ts
//
// Transforms the curated federal prime small-business-liaison (SBLO)
// directory CSV into a typed TS data module that tsc compiles into dist/
// — so the directory ships inside the baked backend image (Dockerfile
// `COPY . .`) without a runtime asset path or CSV parser. Re-run after
// the CSV changes:
//
//   node backend/scripts/genPrimeSbloDirectory.mjs
//
// WHY A BAKED CORPUS AND NOT A SCRAPER: both publishers sit behind CDN
// bot protection and answer non-browser clients with HTTP 403 (verified
// 2026-07-29 against www.dla.mil and business.defense.gov, including with
// a browser User-Agent). A runtime fetcher would fail in production, so
// the directory is refreshed by hand — re-download the two source files,
// update the CSV, re-run this script, and bump `retrieved`. Row-level
// provenance (source_url, published, retrieved) is carried through to the
// generated module so a stale entry is always attributable.
//
// SOURCE FIDELITY: rows are reproduced as published, including apparent
// typos (see the `notes` column). Emails are government-published business
// POC addresses, NOT deliverability-verified — consumers must never treat
// them as `verified` or auto-send to them (GB-104).
// =============================================================
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CSV_PATH = join(__dirname, '..', 'data-sources', 'prime-sblo-directory.csv')
const OUT_PATH = join(__dirname, '..', 'src', 'data', 'primeSbloDirectory.ts')

/** Quote-aware single-line CSV field splitter (handles "" escapes). */
function splitCsvLine(line) {
  const out = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
      } else cur += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

const clean = (s) => (s ?? '').trim()
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const raw = readFileSync(CSV_PATH, 'utf8')
const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0)
const header = splitCsvLine(lines.shift()).map((h) => clean(h))
const col = (name) => {
  const i = header.indexOf(name)
  if (i < 0) throw new Error(`prime-sblo-directory.csv is missing required column "${name}"`)
  return i
}
const C = {
  sourceKey: col('source_key'), sourceLabel: col('source_label'), sourceUrl: col('source_url'),
  published: col('published'), retrieved: col('retrieved'), agency: col('agency'),
  prime: col('prime'), pocName: col('poc_name'), pocTitle: col('poc_title'),
  phone: col('phone'), email: col('email'),
}

const records = []
const seen = new Set()
let skippedNoPrime = 0
let skippedNoContact = 0
let skippedDuplicate = 0

for (const [idx, line] of lines.entries()) {
  const f = splitCsvLine(line)
  const prime = clean(f[C.prime])
  if (!prime) { skippedNoPrime++; continue }

  const pocName = clean(f[C.pocName]) || null
  const emailRaw = clean(f[C.email])
  const email = EMAIL_RE.test(emailRaw) ? emailRaw : null
  // The pool keys a POC on email-or-name; a row with neither is uncapturable.
  if (!pocName && !email) { skippedNoContact++; continue }

  // Exact duplicates would be harmless downstream (the pool upserts) but
  // signal a bad CSV edit — surface them at generation time instead.
  const key = `${clean(f[C.sourceKey])}|${prime.toLowerCase()}|${(email ?? pocName ?? '').toLowerCase()}`
  if (seen.has(key)) {
    skippedDuplicate++
    console.warn(`  duplicate row ${idx + 2} skipped: ${key}`)
    continue
  }
  seen.add(key)

  records.push({
    sourceKey: clean(f[C.sourceKey]),
    sourceLabel: clean(f[C.sourceLabel]),
    sourceUrl: clean(f[C.sourceUrl]) || null,
    published: clean(f[C.published]) || null,
    retrieved: clean(f[C.retrieved]) || null,
    agency: clean(f[C.agency]) || null,
    prime,
    pocName,
    pocTitle: clean(f[C.pocTitle]) || null,
    phone: clean(f[C.phone]) || null,
    email,
  })
}

records.sort((a, b) =>
  a.sourceKey.localeCompare(b.sourceKey) ||
  a.prime.localeCompare(b.prime) ||
  (a.pocName ?? '').localeCompare(b.pocName ?? '')
)

const fileHeader = `// =============================================================
// GENERATED FILE — do not edit by hand.
// Source: backend/data-sources/prime-sblo-directory.csv
// Regenerate: node backend/scripts/genPrimeSbloDirectory.mjs
//
// Federal prime small-business-liaison (SBLO) directory: the point-of-
// contact data published on DLA's subcontracting page
// (https://www.dla.mil/Small-Business/Vendor-Opportunities/Subcontracting/)
// — its Strategic Subcontracting OEM POC spreadsheet, plus the DoD/DoW
// Prime Contractor Directory (Comprehensive Subcontracting Plan) that the
// same page points to. These are the primes carrying FAR 52.219-9
// subcontracting plans; the listed liaisons administer those plans.
//
// Public-domain U.S. Government work (17 U.S.C. 105), published expressly
// to route small businesses to prime subcontracting contacts.
//
// Refreshed by hand — both publishers 403 non-browser clients, so there is
// no runtime fetch. Entries are reproduced as published (apparent source
// typos included) and are NOT deliverability-verified: never mark them
// \`verified\` and never auto-send to them (GB-104). Any outbound use must
// satisfy CAN-SPAM (accurate headers, physical address, one-step opt-out).
// =============================================================

export interface PrimeSbloRecord {
  /** Stable source identifier, e.g. 'dla_captains_of_industry'. */
  sourceKey: string
  /** Human-readable name of the publishing directory. */
  sourceLabel: string
  /** URL the row was published at (may 403 to non-browser clients). */
  sourceUrl: string | null
  /** Publication date of the source document (ISO date, best known). */
  published: string | null
  /** Date this row was last retrieved from the source (ISO date). */
  retrieved: string | null
  /** Publishing/owning agency context, e.g. 'DLA' or 'DOD'. */
  agency: string | null
  /** Prime contractor / OEM as named in the source. */
  prime: string
  pocName: string | null
  /** Liaison role as published, e.g. 'SBLO' or 'Alternate POC'. */
  pocTitle: string | null
  phone: string | null
  /** Syntactically valid address only — NOT deliverability-verified. */
  email: string | null
}

export const PRIME_SBLO_DIRECTORY: PrimeSbloRecord[] = [
`

const body = records.map((r) => '  ' + JSON.stringify(r) + ',').join('\n')
const footer = `
]

/** Distinct source keys present in the directory. */
export const PRIME_SBLO_SOURCE_KEYS: string[] = ${JSON.stringify([...new Set(records.map((r) => r.sourceKey))].sort())}
`

mkdirSync(dirname(OUT_PATH), { recursive: true })
writeFileSync(OUT_PATH, fileHeader + body + footer, 'utf8')

const bySource = {}
for (const r of records) bySource[r.sourceKey] = (bySource[r.sourceKey] ?? 0) + 1
console.log(`Wrote ${records.length} records to ${OUT_PATH}`)
console.log(`  by source: ${Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join(' | ')}`)
console.log(`  with email: ${records.filter((r) => r.email).length} | with phone: ${records.filter((r) => r.phone).length} | with name: ${records.filter((r) => r.pocName).length}`)
console.log(`  skipped: noPrime=${skippedNoPrime} noContact=${skippedNoContact} duplicate=${skippedDuplicate}`)
