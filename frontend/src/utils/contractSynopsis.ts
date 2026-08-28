// ── Plain-language contract synopsis ──────────────────────────────
// SAM.gov descriptions are usually HTML fragments that open with FAR
// boilerplate saying nothing about the actual work (e.g. "This is a combined
// synopsis/solicitation prepared in accordance with Subpart 12.6..."). This
// strips the markup and boilerplate, leads with the purpose/scope, and returns
// a readable up-to-3-sentence summary of what the contract is and asks for.
const SYNOPSIS_BOILERPLATE =
  /(combined synopsis\/solicitation|prepared in accordance with|subpart 12\.6|in accordance with the format|incorporated by reference|provisions? and clauses?|this is for market research(?: only)?|no (?:proposals?|solicitation|award) (?:are|is) (?:being )?(?:requested|issued|made|anticipated)|this is not a (?:request for proposal|solicitation|commitment)|this (?:is|notice|announcement|posting|amendment) (?:is )?(?:a |an )?(?:combined |sources[- ]sought|special notice|pre[- ]?solicitation|presolicitation|request for information|rfi\b|amendment))/i

const SYNOPSIS_PURPOSE =
  /(purpose|objective|the intent|scope of work|statement of work|(?:the )?contractor (?:shall|will|must)|shall (?:provide|furnish|perform|deliver)|seeking|seeks|intends to|requir(?:es|ed|ement)|to (?:provide|furnish|perform|deliver|support|operate|maintain|install|design|construct|supply)|in support of|the government (?:is|requires|seeks|intends|desires|needs)|this (?:contract|requirement|effort|acquisition|procurement|project|order|solicitation) (?:is|will|seeks|provides|requires))/i

// Pure-admin tails to drop UNCONDITIONALLY (even though "purposes" trips the
// SYNOPSIS_PURPOSE escape via its "purpose" substring). Anchored to end-of-
// sentence so a sentence that embeds real scope AFTER "only" — e.g. "...for
// market research purposes only to identify firms capable of janitorial
// services" — is kept, not dropped.
const SYNOPSIS_ADMIN_ONLY =
  /for (?:informational|market research|planning|market survey)(?: purposes)? only[.,;:\s]*$/i

export function buildContractSynopsis(description?: string): string {
  if (!description) return ''
  const DOT = '§DOT§'
  // First strip HTML and decode entities — SAM returns description as an HTML
  // fragment — then normalise whitespace and drop any leading URLs.
  const text = description
    // Closing block/row/cell/list/line tags become sentence boundaries so table
    // cells and list items can't run into the next sentence; the catch-all strip
    // below removes every other tag.
    .replace(/<\/(?:p|div|td|tr|th|li|h[1-6]|table|thead|tbody|ul|ol)>|<br\s*\/?>/gi, '. ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&rsquo;|&lsquo;|&#39;|&apos;/gi, "'")
    .replace(/&mdash;|&ndash;/gi, '-')
    .replace(/&#?\w+;/g, ' ')
    .split(DOT).join(' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*\.(?:\s*\.)+/g, '.')   // collapse ". . ." runs from adjacent closers
    .replace(/\s+\./g, '.')             // tidy " ." -> "."
    .replace(/^(?:\s*https?:\/\/\S+\s*)+/gi, '')
    .replace(/^[.\s]+/, '')             // drop any leading orphan period
    .trim()
  if (!text) return ''
  // Protect abbreviation/decimal/section dots so the splitter doesn't break
  // mid-phrase on "U.S.", "St. Louis", "Inc.", "12.6", "3.2.1" or "1." lists.
  const protectedText = text
    .replace(/(\d)\.(?=\d)/g, `$1${DOT}`)
    .replace(/(^|[\s(])(\d{1,2})\.(?=\s)/g, `$1$2${DOT}`)
    .replace(/\b(?:[A-Za-z]\.){2,}/g, (m) => m.split('.').join(DOT))
    .replace(/\b(No|Inc|Corp|Co|Ltd|LLC|St|Ave|Rd|Blvd|Mt|Dr|Mr|Mrs|Ms|Jr|Sr|vs|etc|approx|Sec|Subpart|Fig|Dept|Govt|Ph\.D)\./gi, (m) => m.split('.').join(DOT))
  const sentences = (protectedText.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [protectedText])
    .map((s) => s.split(DOT).join('.').trim())
    // Drop one/two-word fragments — almost always table headers / cell residue
    // ("Item", "Qty") that survived tag-stripping, not real sentences.
    .filter((s) => (s.match(/[A-Za-z]{2,}/g) || []).length >= 3)
  if (sentences.length === 0) return ''
  // Drop boilerplate sentences unless they also carry purpose/scope content,
  // plus any pure-admin "for ... purposes only" tail (dropped unconditionally).
  const pool = sentences.filter((s) =>
    !SYNOPSIS_ADMIN_ONLY.test(s) && (!SYNOPSIS_BOILERPLATE.test(s) || SYNOPSIS_PURPOSE.test(s)),
  )
  // If everything was boilerplate, return nothing so the caller falls back to a
  // plain NAICS line instead of surfacing the FAR text we tried to strip.
  if (pool.length === 0) return ''
  // Lead with the first sentence that states a purpose/scope, wherever it sits —
  // SAM synopses often bury the real "what this is" line after admin text.
  const purposeIdx = pool.findIndex((s) => SYNOPSIS_PURPOSE.test(s))
  const startIdx = purposeIdx > 0 ? purposeIdx : 0
  const ordered = pool.slice(startIdx)
  // Take up to 3 sentences / ~480 chars, reading forward for coherence.
  const MAX_CHARS = 480
  const MAX_SENTENCES = 3
  const picked: string[] = []
  let len = 0
  for (const s of ordered) {
    if (picked.length >= MAX_SENTENCES) break
    if (picked.length > 0 && len + s.length + 1 > MAX_CHARS) break
    picked.push(s)
    len += s.length + 1
  }
  let out = picked.join(' ').trim()
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS - 1).replace(/\s+\S*$/, '') + '…'
  return out
}
