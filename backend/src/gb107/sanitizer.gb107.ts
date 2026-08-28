// =============================================================
// GB-107 HTML sanitizer + plain-text extraction.
//
// The noticedesc body is arbitrary agency-authored HTML. Stored
// HTML is sanitized (scripts/iframes/event handlers stripped) so
// it can ever be rendered safely; the plain-text version feeds
// clause extraction, full-text matching, and the description
// column read by the matcher / decision engine / MCP detail.
// =============================================================
import sanitizeHtml from 'sanitize-html'

const MAX_TEXT_CHARS = 1_000_000

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  sect: '§',
  para: '¶',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  deg: '°',
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = parseInt(dec, 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''
    })
    .replace(/&([a-zA-Z]+);/g, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

/** Sanitized HTML safe for storage/rendering: no scripts, iframes, styles, or event handlers. */
export function sanitizeDescriptionHtml(raw: string): string {
  return sanitizeHtml(raw, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'u']),
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
  })
}

/** Plain text with paragraph structure preserved, entities decoded, whitespace collapsed. */
export function htmlToPlainText(raw: string): string {
  const withBreaks = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|table|section)>/gi, '$&\n')
  const stripped = sanitizeHtml(withBreaks, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
  })
  const decoded = decodeEntities(stripped)
  return decoded
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS)
}
