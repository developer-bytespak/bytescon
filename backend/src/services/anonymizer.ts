import fs from 'fs'
import path from 'path'

// Defense-in-depth regex scrubbing for shared templates. NOTE: regex cannot
// reliably catch free-text PII (especially person/place names — that needs NER)
// and must NOT be treated as sufficient de-identification of CUI. The durable
// fix is a human redaction-review gate before a template is shared cross-tenant
// (see CODE_REVIEW_2026-06-27.md, C5). These patterns reduce the leak surface
// for the structured identifiers most common in gov-con documents.
const REDACTION_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL ADDRESS]' },
  { pattern: /https?:\/\/[^\s<>"]+/g, replacement: '[WEBSITE]' },
  { pattern: /www\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[WEBSITE]' },
  { pattern: /\b[A-Z0-9]{4,6}-\d{2}-[A-Z]-\d{4,5}\b/g, replacement: '[CONTRACT NUMBER]' },
  // Social Security Number
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[SSN]' },
  // Employer Identification Number (federal tax ID)
  { pattern: /\b\d{2}-\d{7}\b/g, replacement: '[EIN]' },
  // US phone numbers (optional +1, parens, ./-/space separators)
  { pattern: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, replacement: '[PHONE]' },
  // Labeled federal entity identifiers: UEI (12), CAGE (5), DUNS (9)
  { pattern: /\bUEI[:#\s]*[A-Z0-9]{12}\b/gi, replacement: 'UEI [REDACTED]' },
  { pattern: /\bCAGE(?:\s*code)?[:#\s]*[A-Z0-9]{5}\b/gi, replacement: 'CAGE [REDACTED]' },
  { pattern: /\bDUNS[:#\s]*\d{9}\b/gi, replacement: 'DUNS [REDACTED]' },
]

function scrubText(text: string, companyName: string): { result: string; count: number } {
  let result = text
  let count = 0

  // Replace the company name (and a common legal-suffix-stripped variant, so
  // "Acme Corp" is also redacted where the document just says "Acme").
  if (companyName && companyName.trim().length > 2) {
    const variants = new Set<string>([companyName.trim()])
    const noSuffix = companyName
      .trim()
      .replace(/[,.]?\s*(inc|incorporated|llc|l\.l\.c\.|corp|corporation|co|company|ltd|limited|llp|lp|pllc)\.?$/i, '')
      .trim()
    if (noSuffix.length > 2) variants.add(noSuffix)
    for (const v of variants) {
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const nameRe = new RegExp(escaped, 'gi')
      const before = result
      result = result.replace(nameRe, '[COMPANY NAME]')
      if (result !== before) count++
    }
  }

  // Apply all other redaction rules
  for (const rule of REDACTION_RULES) {
    rule.pattern.lastIndex = 0
    const before = result
    result = result.replace(rule.pattern, rule.replacement)
    if (result !== before) count++
  }

  return { result, count }
}

export async function anonymizeDocument(
  inputPath: string,
  outputPath: string,
  companyName: string,
): Promise<{ patternsReplaced: number; outputPath: string }> {
  const ext = path.extname(inputPath).toLowerCase()
  let rawText: string

  if (ext === '.txt' || ext === '.md') {
    rawText = fs.readFileSync(inputPath, 'utf-8')
  } else if (ext === '.docx') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mammoth = require('mammoth')
    const r = await mammoth.extractRawText({ path: inputPath })
    rawText = r.value
  } else {
    throw new Error('Unsupported file type. Please upload .docx or .txt files.')
  }

  const { result: anonymized, count } = scrubText(rawText, companyName)
  const finalPath = outputPath.replace(/\.[^.]+$/, '.txt')
  fs.writeFileSync(finalPath, anonymized, 'utf-8')
  return { patternsReplaced: count, outputPath: finalPath }
}
