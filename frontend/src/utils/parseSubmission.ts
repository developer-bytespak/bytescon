export interface SubmissionInfo {
  email?: string
  contactName?: string
  method: string
  documents: string[]
  steps: string[]
  subjectLine?: string
  rawFound: boolean
}

export function parseSubmissionInstructions(text: string): SubmissionInfo {
  const result: SubmissionInfo = { method: 'See solicitation for details', documents: [], steps: [], rawFound: false }
  // Only attempt parsing on substantial text that looks like a solicitation document
  // Short synopses (< 400 chars) rarely contain actionable submission instructions
  if (!text || text.length < 400) return result

  // Extract email addresses (prefer .gov)
  const emailMatches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)
  if (emailMatches) {
    result.email = emailMatches.find((e) => e.endsWith('.gov')) ?? emailMatches[0]
  }

  // Detect submission method
  if (result.email) {
    result.method = 'Email submission'
  } else if (/eBuy|SAM\.gov|beta\.sam/i.test(text)) {
    result.method = 'Online portal (SAM.gov / eBuy)'
  } else if (/physical|hard copy|deliver to|mail to/i.test(text)) {
    result.method = 'Physical / mail submission'
  }

  // Extract email subject line hint
  const subjectMatch = text.match(/subject\s+line[:\s]+([^\n]{5,100})/i)
  if (subjectMatch) result.subjectLine = subjectMatch[1].trim().replace(/^['"]|['"]$/g, '')

  // Extract document/volume/attachment requirements
  const docRe = /(?:Volume\s+\d+[^.\n]{0,60}|Attachment\s+\d+[^.\n]{0,60}|Section\s+[A-Z\d]+[^.\n]{0,60})/gi
  const docMatches = Array.from(new Set((text.match(docRe) || []).map((d) => d.trim())))
  result.documents = docMatches.filter((d) => d.length > 4 && d.length < 120).slice(0, 8)

  // Find the submission instructions section
  const sectionIdx = text.search(/submission\s+instructions?|quote\s+preparation|proposal\s+preparation|how\s+to\s+submit|preparation\s+instructions/i)
  if (sectionIdx >= 0) {
    result.rawFound = true
    const section = text.slice(sectionIdx, sectionIdx + 2500)
    // Extract lettered/numbered steps
    const stepRe = /(?:^|\n)\s*(?:[a-z]\)|\d+\.|[-*])\s+([^\n]{15,280})/gm
    const steps: string[] = []
    let m: RegExpExecArray | null
    while ((m = stepRe.exec(section)) !== null) steps.push(m[1].trim())
    result.steps = steps.filter((s) => s.length > 15).slice(0, 8)
  }

  return result
}
