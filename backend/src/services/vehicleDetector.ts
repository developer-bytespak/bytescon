// =============================================================
// Vehicle Detector
// Detects contract vehicles from opportunity title/description
// =============================================================

export interface VehicleMatch {
  vehicle: string   // canonical display name e.g. "OASIS+"
  type: string      // "GWAC" | "IDIQ" | "BPA" | "MAS" | "BOA" | "MATOC"
  confidence: number
}

interface VehiclePattern {
  vehicle: string
  type: string
  patterns: RegExp[]
}

const VEHICLE_PATTERNS: VehiclePattern[] = [
  // ── GWACs ──────────────────────────────────────────────────
  {
    vehicle: 'OASIS+',
    type: 'GWAC',
    patterns: [/oasis\+/i, /oasis plus/i, /one acquisition solution for integrated services/i],
  },
  {
    vehicle: 'OASIS',
    type: 'GWAC',
    patterns: [/\boasis\b/i],
  },
  {
    vehicle: 'SEWP V',
    type: 'GWAC',
    patterns: [/sewp\s*v\b/i, /sewp\s*5\b/i, /solutions for enterprise.wide procurement/i],
  },
  {
    vehicle: 'SEWP',
    type: 'GWAC',
    patterns: [/\bsewp\b/i],
  },
  {
    vehicle: 'Alliant 3',
    type: 'GWAC',
    patterns: [/alliant\s*3/i],
  },
  {
    vehicle: 'Alliant 2',
    type: 'GWAC',
    patterns: [/alliant\s*2/i],
  },
  {
    vehicle: 'CIO-SP4',
    type: 'GWAC',
    patterns: [/cio.sp\s*4/i, /cio-sp4/i],
  },
  {
    vehicle: 'CIO-SP3',
    type: 'GWAC',
    patterns: [/cio.sp\s*3/i, /cio-sp3/i],
  },
  {
    vehicle: '8(a) STARS III',
    type: 'GWAC',
    patterns: [/stars\s*iii/i, /stars\s*3/i, /8\(a\)\s*stars/i],
  },
  {
    vehicle: 'Polaris',
    type: 'GWAC',
    patterns: [/\bpolaris\b/i],
  },
  {
    vehicle: 'VETS 2',
    type: 'GWAC',
    patterns: [/vets\s*2\b/i, /veterans technology services\s*2/i],
  },
  {
    vehicle: 'T4NG',
    type: 'GWAC',
    patterns: [/\bt4ng\b/i, /transformation twenty.one total technology/i],
  },
  {
    vehicle: 'ITES-3S',
    type: 'GWAC',
    patterns: [/ites.3s/i, /ites-3/i],
  },
  {
    vehicle: 'NETCENTS-2',
    type: 'GWAC',
    patterns: [/netcents.2/i, /netcents2/i],
  },
  {
    vehicle: 'SPARC',
    type: 'GWAC',
    patterns: [/\bsparc\b/i],
  },
  {
    vehicle: 'RS3',
    type: 'GWAC',
    patterns: [/\brs3\b/i, /rapid support services/i],
  },

  // ── GSA Schedules / MAS ───────────────────────────────────
  {
    vehicle: 'GSA MAS',
    type: 'MAS',
    patterns: [/gsa\s*(multiple award schedule|mas)\b/i, /federal supply schedule/i, /\bfss\b/i],
  },
  {
    vehicle: 'GSA Schedule 70',
    type: 'MAS',
    patterns: [/schedule\s*70\b/i, /it\s*schedule\s*70/i],
  },
  {
    vehicle: 'GSA Schedule 84',
    type: 'MAS',
    patterns: [/schedule\s*84\b/i],
  },

  // ── DOD / Agency IDIQs ────────────────────────────────────
  {
    vehicle: 'EAGLE II',
    type: 'IDIQ',
    patterns: [/eagle\s*ii\b/i, /eagle-ii/i],
  },
  {
    vehicle: 'ENCORE III',
    type: 'IDIQ',
    patterns: [/encore\s*iii/i, /encore\s*3/i],
  },
  {
    vehicle: 'SeaPort-e',
    type: 'IDIQ',
    patterns: [/seaport.e\b/i, /seaport nxg/i],
  },
  {
    vehicle: 'SETI',
    type: 'IDIQ',
    patterns: [/\bseti\b/i, /scientific engineering technical/i],
  },
  {
    vehicle: 'RAMP',
    type: 'IDIQ',
    patterns: [/\bramp\b.*contract/i],
  },
  {
    vehicle: 'HCATS',
    type: 'IDIQ',
    patterns: [/\bhcats\b/i, /human capital and training solutions/i],
  },

  // ── Generic vehicle types (lower confidence) ──────────────
  {
    vehicle: 'GWAC',
    type: 'GWAC',
    patterns: [/\bgwac\b/i, /government.wide acquisition contract/i],
  },
  {
    vehicle: 'IDIQ',
    type: 'IDIQ',
    patterns: [/\bidiq\b/i, /indefinite.delivery.indefinite.quantity/i],
  },
  {
    vehicle: 'BPA',
    type: 'BPA',
    patterns: [/\bbpa\b/i, /blanket purchase agreement/i],
  },
  {
    vehicle: 'BOA',
    type: 'BOA',
    patterns: [/\bboa\b/i, /basic ordering agreement/i],
  },
  {
    vehicle: 'MATOC',
    type: 'MATOC',
    patterns: [/\bmatoc\b/i, /multiple award task order/i],
  },
  {
    vehicle: 'MAC',
    type: 'IDIQ',
    patterns: [/\bmac\b.*contract/i, /multiple award contract/i],
  },
]

// Specific named vehicles get full confidence; generic types get lower
const NAMED_VEHICLES = new Set([
  'OASIS+','OASIS','SEWP V','SEWP','Alliant 3','Alliant 2','CIO-SP4','CIO-SP3',
  '8(a) STARS III','Polaris','VETS 2','T4NG','ITES-3S','NETCENTS-2','SPARC',
  'RS3','GSA MAS','GSA Schedule 70','GSA Schedule 84','EAGLE II','ENCORE III',
  'SeaPort-e','SETI','RAMP','HCATS',
])

export function detectVehicle(title: string, description?: string | null): VehicleMatch | null {
  const text = `${title} ${description || ''}`.trim()

  for (const entry of VEHICLE_PATTERNS) {
    for (const pattern of entry.patterns) {
      if (pattern.test(text)) {
        const confidence = NAMED_VEHICLES.has(entry.vehicle) ? 0.92 : 0.65
        return { vehicle: entry.vehicle, type: entry.type, confidence }
      }
    }
  }
  return null
}

// Scan multiple fields and return best match
export function detectVehicleFromOpportunity(fields: {
  title: string
  description?: string | null
  noticeType?: string | null
}): VehicleMatch | null {
  // Title match is highest signal
  const titleMatch = detectVehicle(fields.title, '')
  if (titleMatch && titleMatch.confidence >= 0.9) return titleMatch

  // Full-text match (title + description)
  const fullMatch = detectVehicle(fields.title, fields.description)
  return fullMatch
}
