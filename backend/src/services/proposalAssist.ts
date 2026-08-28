import { generateWithRouter } from './llm/llmRouter'
import { logger } from '../utils/logger'

export interface ProposalOutline {
  executiveSummary: string
  winThemes: string[]
  sections: Array<{
    title: string
    description: string
    keyPoints: string[]
    pageEstimate: string
  }>
  discriminators: string[]
  riskMitigations: string[]
  pastPerformanceHint: string
}

export async function generateProposalOutline(
  opportunityTitle: string,
  agency: string,
  requirements: Array<{ section: string; requirementText: string; isMandatory: boolean }>,
  enrichment: { naicsCode?: string; setAsideType?: string | null; estimatedValue?: number | null; historicalWinner?: string | null },
  consultingFirmId: string,
  userGuidance?: string
): Promise<ProposalOutline> {
  // Keep top 12 mandatory requirements to stay well under token limits
  const reqSummary = requirements
    .filter(r => r.isMandatory)
    .slice(0, 12)
    .map(r => `- [${r.section}] ${r.requirementText.slice(0, 200)}`)
    .join('\n')

  const systemPrompt = `You are an expert federal proposal writer. Generate a structured proposal outline that directly addresses the stated requirements. Be specific, practical, and focused on winning. Output valid, COMPACT JSON only — no markdown, no commentary. Hard limits to keep the response complete: at most 8 sections; each description at most 25 words; every array at most 4 items; keep all strings concise.`

  const userPrompt = `Generate a proposal outline for this federal opportunity.

Opportunity: ${opportunityTitle}
Agency: ${agency}
NAICS: ${enrichment.naicsCode ?? 'Not specified'}
Set-Aside: ${enrichment.setAsideType ?? 'None'}
Estimated Value: ${enrichment.estimatedValue ? '$' + enrichment.estimatedValue.toLocaleString() : 'Not published'}
Historical Winner: ${enrichment.historicalWinner ?? 'Unknown'}
${userGuidance ? `\nAdditional Guidance from Proposal Manager:\n${userGuidance}\n` : ''}
Mandatory Requirements:
${reqSummary || 'No requirements extracted yet — use opportunity description'}

Return this exact JSON structure:
{
  "executiveSummary": "2-3 sentence winning executive summary approach",
  "winThemes": ["theme1", "theme2", "theme3"],
  "sections": [
    {
      "title": "Section name",
      "description": "What this section covers",
      "keyPoints": ["point1", "point2"],
      "pageEstimate": "X-Y pages"
    }
  ],
  "discriminators": ["what sets your firm apart for this specific opportunity"],
  "riskMitigations": ["risks to address proactively"],
  "pastPerformanceHint": "What past performance to highlight"
}

Output compact JSON only. Do not exceed 8 sections.`

  let response
  try {
    // maxTokens 8000: the prior 2000 ceiling truncated the JSON for any
    // non-trivial opportunity, causing JSON.parse to fail and surfacing a
    // misleading "valid AI key" error. The system prompt also caps section
    // count / string length so the response stays well under this ceiling.
    response = await generateWithRouter(
      { systemPrompt, userPrompt, maxTokens: 8000, temperature: 0.2 },
      consultingFirmId,
      { task: 'BID_GUIDANCE', useCache: false }
    )
  } catch (llmErr) {
    const msg = (llmErr as Error).message
    // Re-throw errors the route handler maps to specific responses. The route
    // throws BEFORE deducting tokens, so the user is never charged on failure.
    if (msg === 'NO_LLM_KEY' || msg === 'RATE_LIMITED') throw llmErr
    logger.warn('Proposal outline LLM call failed', { error: msg })
    throw new Error('LLM_UNAVAILABLE')
  }

  // Strip markdown code fences, then extract the JSON object (first { to last }).
  const stripped = response.text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  try {
    if (start === -1 || end === -1) throw new Error('No JSON object found')
    return JSON.parse(stripped.slice(start, end + 1)) as ProposalOutline
  } catch (parseErr) {
    // A parse failure here means the model produced non-JSON or (historically)
    // truncated output — NOT a missing/invalid key. Log diagnostics and throw a
    // distinct error so the route can return an honest message without charging.
    logger.warn('Proposal outline JSON parse failed', {
      error: (parseErr as Error).message,
      responseChars: response.text.length,
      head: response.text.slice(0, 200),
    })
    throw new Error('LLM_BAD_OUTPUT')
  }
}
