// =============================================================
// FIX-6 — human-in-the-loop attestation on AI-drafted proposals.
//
// An LLM drafting a federal proposal is a liability surface: fabricated
// facts, invented past performance, or a non-compliant response can go
// out the door under the firm's name. This module holds the attestation
// statement the operator must affirm (a professional-responsibility
// acknowledgement) and the content-hash helper that pins an attestation
// to the exact draft it covers, so a later regeneration reads as STALE.
// =============================================================
import { createHash } from 'crypto'

/**
 * Versioned so we can revise the language later and detect who signed which
 * revision. Bump the version whenever the statement text changes materially.
 */
export const PROPOSAL_ATTESTATION_VERSION = 'v1-2026-07'

export const PROPOSAL_ATTESTATION_STATEMENT =
  'I have reviewed this AI-assisted proposal draft in its entirety. I confirm that its ' +
  'representations, past-performance references, and certifications are accurate and not ' +
  'fabricated; that it complies with the solicitation; and that I — not the AI — take ' +
  'professional responsibility for its contents as submitted to the Government.'

/**
 * Deterministic SHA-256 of the saved draft. Keyed on the section titles +
 * content so cosmetic re-serialization (key ordering, added metadata) does
 * not spuriously invalidate an attestation, while any real content edit does.
 */
export function hashProposalDraft(draft: unknown): string {
  const d = draft as { opportunityTitle?: unknown; sections?: Array<{ title?: unknown; content?: unknown }> } | null
  const basis = {
    title: typeof d?.opportunityTitle === 'string' ? d.opportunityTitle : '',
    sections: Array.isArray(d?.sections)
      ? d!.sections.map((s) => ({
          title: typeof s?.title === 'string' ? s.title : '',
          content: typeof s?.content === 'string' ? s.content : '',
        }))
      : [],
  }
  return createHash('sha256').update(JSON.stringify(basis)).digest('hex')
}
