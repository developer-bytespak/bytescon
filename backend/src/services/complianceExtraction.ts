// =============================================================
// Solicitation compliance extraction (§5.2). COMPLIANCE_EXTRACTION_SYSTEM_PROMPT
// is the EXACT, verbatim system prompt — it must not be shortened, paraphrased,
// or replaced. The LLM path (via the existing generateWithRouter) uses it; the
// pure parse/validate/dedupe helpers are deterministic and unit-tested so the
// JSON contract and "don't duplicate verified requirements" rule are enforced
// regardless of the model. Extraction is honest: with no configured provider it
// surfaces NO_LLM_KEY (the caller lets users add requirements manually) — it
// never ships fabricated fallback requirements.
// =============================================================
import { generateWithRouter } from './llm/llmRouter'

// --- EXACT COMPLIANCE EXTRACTION SYSTEM PROMPT START ---
export const COMPLIANCE_EXTRACTION_SYSTEM_PROMPT = `You are the Solicitation Compliance Extraction Assistant inside Bytescon.

Your task is to extract proposal requirements only from the solicitation text and document metadata explicitly supplied by the application.

Follow these rules exactly:

1. Do not invent, infer, assume, or add requirements that are not supported by the supplied solicitation.
2. Extract explicit instructions, evaluation requirements, submission requirements, formatting rules, page limits, required forms, certifications, representations, attachments, deadlines, volumes, sections, deliverables, and mandatory response elements.
3. Distinguish instructions to offerors from evaluation criteria whenever the source makes that distinction.
4. Preserve the source section and page number when provided.
5. Include a short source-evidence excerpt for human verification.
6. Do not treat general background, marketing language, contract history, or descriptive text as a proposal requirement unless it clearly directs the offeror to provide or comply with something.
7. Mark a requirement as mandatory only when the source uses mandatory language or clearly makes compliance necessary.
8. When the wording is ambiguous, set reviewRequired to true and explain the ambiguity in reviewReason.
9. Never claim that extraction guarantees proposal compliance.
10. Do not assign a human owner unless an owner is explicitly supplied by the application.
11. Do not fabricate proposal section names. You may provide a clearly labelled suggested section only when strongly supported by the source.
12. Avoid duplicate requirements. When the same requirement appears more than once, preserve all relevant source references in one consolidated record.
13. Keep distinct requirements separate even when they appear in the same paragraph.
14. Use an extractionConfidence value between 0 and 1 based only on clarity of the supplied source.
15. Return valid JSON only. Do not include markdown, explanations, or commentary outside the JSON.

Return an array of objects using this exact structure:

[
  {
    "sourceSection": "string or null",
    "sourcePageNumber": "number or null",
    "evidenceText": "string",
    "requirementText": "string",
    "requirementType": "INSTRUCTION | EVALUATION | FORMAT | SUBMISSION | DOCUMENT | CERTIFICATION | DEADLINE | DELIVERABLE | OTHER",
    "mandatory": true,
    "suggestedProposalSection": "string or null",
    "ownerUserId": null,
    "status": "NOT_STARTED",
    "extractionMethod": "AI",
    "extractionConfidence": 0.0,
    "reviewRequired": false,
    "reviewReason": "string or null"
  }
]`
// --- EXACT COMPLIANCE EXTRACTION SYSTEM PROMPT END ---

export const REQUIREMENT_TYPES = ['INSTRUCTION', 'EVALUATION', 'FORMAT', 'SUBMISSION', 'DOCUMENT', 'CERTIFICATION', 'DEADLINE', 'DELIVERABLE', 'OTHER'] as const
export type RequirementType = (typeof REQUIREMENT_TYPES)[number]

export interface ExtractedComplianceRequirement {
  sourceSection: string | null
  sourcePageNumber: number | null
  evidenceText: string
  requirementText: string
  requirementType: RequirementType
  mandatory: boolean
  suggestedProposalSection: string | null
  ownerUserId: string | null
  status: 'NOT_STARTED'
  extractionMethod: 'AI'
  extractionConfidence: number
  reviewRequired: boolean
  reviewReason: string | null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}
function clamp01(n: unknown): number {
  const x = typeof n === 'number' && Number.isFinite(n) ? n : 0
  return x < 0 ? 0 : x > 1 ? 1 : x
}

// Parse and VALIDATE the model output against the exact JSON contract. Rows that
// are not objects, or lack a requirementText, are dropped (not guessed).
export function parseAndValidateRequirements(raw: string): { requirements: ExtractedComplianceRequirement[]; errors: string[] } {
  const errors: string[] = []
  let parsed: unknown
  try {
    // Tolerate a code-fence wrapper but require JSON content.
    const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
    parsed = JSON.parse(cleaned)
  } catch {
    return { requirements: [], errors: ['Model did not return valid JSON.'] }
  }
  if (!Array.isArray(parsed)) return { requirements: [], errors: ['Expected a JSON array of requirements.'] }

  const out: ExtractedComplianceRequirement[] = []
  for (let i = 0; i < parsed.length; i++) {
    const r = parsed[i] as Record<string, unknown>
    if (!r || typeof r !== 'object') { errors.push(`Row ${i}: not an object`); continue }
    const requirementText = str(r.requirementText)
    if (!requirementText) { errors.push(`Row ${i}: missing requirementText`); continue }
    const typeRaw = str(r.requirementType)?.toUpperCase()
    const requirementType = (REQUIREMENT_TYPES as readonly string[]).includes(typeRaw ?? '') ? (typeRaw as RequirementType) : 'OTHER'
    out.push({
      sourceSection: str(r.sourceSection),
      sourcePageNumber: typeof r.sourcePageNumber === 'number' && Number.isFinite(r.sourcePageNumber) ? Math.trunc(r.sourcePageNumber) : null,
      evidenceText: str(r.evidenceText) ?? '',
      requirementText,
      requirementType,
      mandatory: r.mandatory === true,
      suggestedProposalSection: str(r.suggestedProposalSection),
      ownerUserId: null, // never trust a model-supplied owner
      status: 'NOT_STARTED',
      extractionMethod: 'AI',
      extractionConfidence: clamp01(r.extractionConfidence),
      reviewRequired: r.reviewRequired === true,
      reviewReason: str(r.reviewReason),
    })
  }
  return { requirements: out, errors }
}

function normKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160)
}

// Remove freshly-extracted rows that duplicate an existing requirement (by
// normalized text). Re-extraction therefore never duplicates already-persisted
// (especially verified) requirements. Also dedupes within the new batch.
export function dedupeAgainstExisting(
  fresh: ExtractedComplianceRequirement[],
  existing: { requirementText: string }[],
): ExtractedComplianceRequirement[] {
  const seen = new Set(existing.map((e) => normKey(e.requirementText)))
  const result: ExtractedComplianceRequirement[] = []
  for (const r of fresh) {
    const k = normKey(r.requirementText)
    if (seen.has(k)) continue
    seen.add(k)
    result.push(r)
  }
  return result
}

// Call the LLM with the EXACT prompt. Throws NO_LLM_KEY (surfaced honestly by
// the caller) when no provider is configured — never a fabricated fallback.
export async function extractComplianceRequirements(
  solicitationText: string,
  meta: { documentName?: string; opportunityTitle?: string },
  consultingFirmId: string,
): Promise<{ requirements: ExtractedComplianceRequirement[]; errors: string[] }> {
  const userPrompt = [
    meta.opportunityTitle ? `Opportunity: ${meta.opportunityTitle}` : '',
    meta.documentName ? `Document: ${meta.documentName}` : '',
    'SOLICITATION TEXT (the only source — extract requirements only from this):',
    solicitationText.slice(0, 60000),
  ].filter(Boolean).join('\n\n')

  const res = await generateWithRouter(
    { systemPrompt: COMPLIANCE_EXTRACTION_SYSTEM_PROMPT, userPrompt, maxTokens: 4000, temperature: 0.2 },
    consultingFirmId,
    { task: 'COMPLIANCE_MATRIX', useCache: false },
  )
  return parseAndValidateRequirements(res.text ?? '')
}
