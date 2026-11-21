// =============================================================
// The format a proposal must follow: the template's standard format, with the
// solicitation's own rules on top (its Section L, read into the compliance
// matrix as requirements): font, font size, margins, line spacing and page
// limits per volume. Each rule says where it came from, so a person can check
// it against the solicitation. Pure: reads requirement texts only.
// =============================================================

export type VolumeKey = 'technical' | 'pastPerformance' | 'price' | 'capability' | 'total'

export interface PageLimit { volume: VolumeKey; pages: number; source: string }

export interface ProposalFormat {
  font: string
  /** The PDF can only embed its standard fonts: the one it uses for `font`. */
  pdfFont: 'Times' | 'Helvetica' | 'Courier'
  fontSize: number
  marginsIn: number
  lineSpacing: number
  pageLimits: PageLimit[]
  /** Where each rule taken from the solicitation came from (rule -> requirement text). */
  sources: Array<{ rule: string; text: string }>
}

export const STANDARD_FORMAT: Omit<ProposalFormat, 'pageLimits' | 'sources'> = {
  font: 'Times New Roman', pdfFont: 'Times', fontSize: 12, marginsIn: 1, lineSpacing: 1,
}

const FONTS: Array<[RegExp, string, ProposalFormat['pdfFont']]> = [
  [/times new roman|times roman/i, 'Times New Roman', 'Times'],
  [/\barial\b/i, 'Arial', 'Helvetica'],
  [/\bcalibri\b/i, 'Calibri', 'Helvetica'],
  [/\bhelvetica\b/i, 'Helvetica', 'Helvetica'],
  [/\bverdana\b/i, 'Verdana', 'Helvetica'],
  [/courier new|\bcourier\b/i, 'Courier New', 'Courier'],
  [/\bgaramond\b/i, 'Garamond', 'Times'],
  [/\bcambria\b/i, 'Cambria', 'Times'],
  [/\bgeorgia\b/i, 'Georgia', 'Times'],
]

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50 }
const num = (s: string) => NUMBER_WORDS[s.toLowerCase()] ?? Number(s)

/** Which volume a page-limit sentence is about, from the words just before the number. */
function volumeOf(context: string): VolumeKey {
  const c = context.toLowerCase()
  const hits: Array<[number, VolumeKey]> = []
  const find = (re: RegExp, v: VolumeKey) => { const m = [...c.matchAll(re)].pop(); if (m) hits.push([m.index ?? 0, v]) }
  find(/past performance/g, 'pastPerformance')
  find(/\b(price|pricing|cost)\b/g, 'price')
  find(/\bcapabilit(y|ies)( statement)?\b/g, 'capability')
  find(/\b(technical|management|approach)\b/g, 'technical')
  // The volume named closest before the number wins.
  return hits.sort((a, b) => b[0] - a[0])[0]?.[1] ?? 'total'
}

const LIMIT = /(?:not\s+(?:to\s+)?exceed|no\s+more\s+than|maximum\s+of|max(?:imum)?\.?|limited\s+to|up\s+to|at\s+most|shall\s+not\s+be\s+more\s+than)\s*(?:a\s+)?(?:total\s+of\s+)?(\d{1,3}|[a-z]+)(?:\s*\(\d{1,3}\))?\s*(?:single[- ]sided\s+)?pages?|(\d{1,3}|[a-z]+)(?:\s*\(\d{1,3}\))?[- ]page\s+(?:limit|maximum)/gi

/** The solicitation's format rules found in its requirement texts. */
export function readFormat(requirementTexts: string[]): ProposalFormat {
  const fmt: ProposalFormat = { ...STANDARD_FORMAT, pageLimits: [], sources: [] }
  // Placeholders the AI wrote where the solicitation text was missing say nothing.
  const texts = requirementTexts.filter((t) => t && !/^\s*\[(EVIDENCE_NEEDED|[A-Z ]*REQUIRED)/.test(t))
  const note = (rule: string, text: string) => fmt.sources.push({ rule, text: text.length > 220 ? `${text.slice(0, 217)}…` : text })

  for (const t of texts) {
    const font = FONTS.find(([re]) => re.test(t))
    if (font && /font|type ?face|print/i.test(t) && fmt.sources.every((s) => !s.rule.startsWith('Font:'))) {
      fmt.font = font[1]; fmt.pdfFont = font[2]; note(`Font: ${font[1]}`, t)
    }
    const size = t.match(/\b(\d{1,2}(?:\.\d)?)\s*-?\s*(?:point|pt\.?)(?:\s+font|\s+type)?\b/i)
    if (size && /font|type|point|pt/i.test(t)) {
      const n = Number(size[1])
      if (n >= 8 && n <= 16 && fmt.sources.every((s) => !s.rule.startsWith('Font size:'))) { fmt.fontSize = n; note(`Font size: ${n} pt`, t) }
    }
    const margin = t.match(/(\d(?:\.\d{1,2})?|one|half)\s*(?:-|\s)?(?:inch(?:es)?|in\.|")\s*margins?|margins?\s*(?:of|shall be|must be|:)?\s*(?:at least\s+|no less than\s+|a minimum of\s+)?(\d(?:\.\d{1,2})?|one)\s*(?:-|\s)?(?:inch(?:es)?|in\.|")/i)
    if (margin && fmt.sources.every((s) => !s.rule.startsWith('Margins:'))) {
      const raw = (margin[1] ?? margin[2]).toLowerCase()
      const n = raw === 'half' ? 0.5 : num(raw)
      if (n > 0 && n <= 2) { fmt.marginsIn = n; note(`Margins: ${n} inch`, t) }
    }
    const spacing = t.match(/\b(double|single|1\.5)[- ]spac/i)
    if (spacing && fmt.sources.every((s) => !s.rule.startsWith('Line spacing:'))) {
      fmt.lineSpacing = spacing[1].toLowerCase() === 'double' ? 2 : spacing[1] === '1.5' ? 1.5 : 1
      note(`Line spacing: ${spacing[1].toLowerCase()}`, t)
    }
    for (const m of t.matchAll(LIMIT)) {
      const pages = num(m[1] ?? m[2])
      if (!Number.isFinite(pages) || pages < 1 || pages > 500) continue
      const volume = volumeOf(t.slice(Math.max(0, (m.index ?? 0) - 120), m.index ?? 0) || t)
      if (fmt.pageLimits.some((l) => l.volume === volume)) continue
      fmt.pageLimits.push({ volume, pages, source: t })
      note(`Page limit (${volume === 'total' ? 'whole proposal' : volume.replace('pastPerformance', 'past performance')}): ${pages}`, t)
    }
  }
  return fmt
}
