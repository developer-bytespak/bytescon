// =============================================================
// §7.5 — Prompt exactness.
//
// The two OPTIONAL Teaming Agent prompts are pinned here by SHA-256, character
// length and UTF-8 byte length. A single changed character — including an
// em-dash silently normalised to a hyphen, or a trailing newline introduced by
// an editor — fails this file.
//
// The hashes below were COMPUTED from the canonical constants, never guessed.
// To change a prompt: edit the constant, bump its version, and update the
// pinned values here in the same commit so the change is visible in review.
// =============================================================
import { createHash } from 'crypto'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import {
  TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT,
  TEAMING_AGREEMENT_NDA_DRAFT_PROMPT_VERSION,
  PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT,
  PARTNER_OUTREACH_DRAFT_PROMPT_VERSION,
  TEAMING_PROMPTS,
  LEGAL_REVIEW_BANNER,
  LEGAL_REVIEW_REASON,
  OUTREACH_SEND_CONTROL_REASON,
  teamingSystemPrompt,
} from './teamingPrompts'

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

/** Pinned from the canonical constants. Any drift fails. */
const PINNED = {
  TEAMING_AGREEMENT_NDA_DRAFT: {
    sha256: '6c2f32d298eda2191f17209d10d73433b1df3456844a7845ef5c64d9855d4f4a',
    chars: 5820,
    bytes: 5824,
    version: 'teaming-agreement-nda-draft-v1',
  },
  PARTNER_OUTREACH_DRAFT: {
    sha256: 'abc6a2eb8281f3ce12c826b8e574160bff3165316a9b316b7b113962348838b6',
    chars: 3663,
    bytes: 3663,
    version: 'partner-outreach-draft-v1',
  },
} as const

// -------------------------------------------------------------
// Prompt A
// -------------------------------------------------------------

describe('TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT', () => {
  const P = PINNED.TEAMING_AGREEMENT_NDA_DRAFT

  it('matches its pinned SHA-256 exactly', () => {
    expect(sha256(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT)).toBe(P.sha256)
  })

  it('matches its pinned character length exactly', () => {
    expect(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT.length).toBe(P.chars)
  })

  it('matches its pinned UTF-8 byte length exactly', () => {
    expect(Buffer.byteLength(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT, 'utf8')).toBe(P.bytes)
  })

  it('carries the four non-ASCII bytes of its two em-dashes', () => {
    // chars < bytes proves the em-dashes survived; a hyphen substitution would
    // silently make them equal.
    expect(P.bytes - P.chars).toBe(4)
    expect(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT).toContain('—')
  })

  it('matches its pinned version', () => {
    expect(TEAMING_AGREEMENT_NDA_DRAFT_PROMPT_VERSION).toBe(P.version)
  })

  it('opens with the exact first line', () => {
    expect(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT.split('\n')[0]).toBe(
      'You are the Teaming Agreement and NDA Drafting Assistant inside Bytescon.',
    )
  })

  it('ends at the closing brace with no trailing whitespace', () => {
    expect(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT.endsWith('}')).toBe(true)
    expect(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT).toBe(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT.trimEnd())
  })

  it('contains the exact legal-review banner', () => {
    expect(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT).toContain(LEGAL_REVIEW_BANNER)
    expect(LEGAL_REVIEW_BANNER).toBe('REQUIRES LEGAL REVIEW — NOT EXECUTABLE')
  })

  it('contains the exact legal-review reason the contract requires', () => {
    expect(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT).toContain(LEGAL_REVIEW_REASON)
  })

  it('pins the non-negotiable output flags', () => {
    expect(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT).toContain('"legalReviewRequired": true')
    expect(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT).toContain('"executionAllowed": false')
    expect(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT).toContain('"status": "DRAFT"')
  })

  it('forbids creating a signature or an execution status', () => {
    expect(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT).toContain(
      '11. Do not create a signature, signature date, electronic-signature event, acceptance event, or execution status.',
    )
  })

  it('requires a proposed workshare to be labelled PROPOSED', () => {
    expect(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT).toContain(
      'A proposed workshare must be labelled PROPOSED and must not be represented as agreed.',
    )
  })

  it('carries all thirty numbered rules', () => {
    for (let n = 1; n <= 30; n += 1) {
      expect(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT, `rule ${n}`).toContain(`\n${n}. `)
    }
    expect(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT).not.toContain('\n31. ')
  })
})

// -------------------------------------------------------------
// Prompt B
// -------------------------------------------------------------

describe('PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT', () => {
  const P = PINNED.PARTNER_OUTREACH_DRAFT

  it('matches its pinned SHA-256 exactly', () => {
    expect(sha256(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT)).toBe(P.sha256)
  })

  it('matches its pinned character length exactly', () => {
    expect(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT.length).toBe(P.chars)
  })

  it('matches its pinned UTF-8 byte length exactly', () => {
    expect(Buffer.byteLength(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT, 'utf8')).toBe(P.bytes)
  })

  it('is pure ASCII, so chars and bytes are equal', () => {
    expect(P.chars).toBe(P.bytes)
  })

  it('matches its pinned version', () => {
    expect(PARTNER_OUTREACH_DRAFT_PROMPT_VERSION).toBe(P.version)
  })

  it('opens with the exact first line', () => {
    expect(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT.split('\n')[0]).toBe(
      'You are the Partner Outreach Drafting Assistant inside Bytescon.',
    )
  })

  it('ends at the closing brace with no trailing whitespace', () => {
    expect(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT.endsWith('}')).toBe(true)
    expect(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT).toBe(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT.trimEnd())
  })

  it('states plainly that it never sends messages', () => {
    expect(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT).toContain('You never send messages.')
  })

  it('pins the non-negotiable send-control flags', () => {
    expect(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT).toContain('"sendAllowed": false')
    expect(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT).toContain('"humanSendRequired": true')
    expect(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT).toContain('"allowed": false')
  })

  it('contains the exact send-control reason the contract requires', () => {
    expect(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT).toContain(OUTREACH_SEND_CONTROL_REASON)
  })

  it('forbids simulating a send or a delivery event', () => {
    expect(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT).toContain(
      '20. Do not create or simulate an email-send action, delivery receipt, message ID, response, meeting acceptance, or communication event.',
    )
  })

  it('forbids leaking another tenant\'s data or private scoring internals', () => {
    expect(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT).toContain(
      "15. Do not expose internal scoring weights, private notes, private competitor intelligence, another tenant's data, hidden system metadata, or confidential information not explicitly approved for outreach.",
    )
  })

  it('carries all twenty-four numbered rules', () => {
    for (let n = 1; n <= 24; n += 1) {
      expect(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT, `rule ${n}`).toContain(`\n${n}. `)
    }
    expect(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT).not.toContain('\n25. ')
  })
})

// -------------------------------------------------------------
// One canonical object; no duplicates
// -------------------------------------------------------------

describe('the prompts are canonical and singular', () => {
  it('exposes the same string identity through the registry object', () => {
    expect(TEAMING_PROMPTS.TEAMING_AGREEMENT_NDA_DRAFT.systemPrompt).toBe(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT)
    expect(TEAMING_PROMPTS.PARTNER_OUTREACH_DRAFT.systemPrompt).toBe(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT)
  })

  it('returns the prompt ALONE from the accessor, with nothing appended', () => {
    expect(teamingSystemPrompt('TEAMING_AGREEMENT_NDA_DRAFT')).toBe(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT)
    expect(teamingSystemPrompt('PARTNER_OUTREACH_DRAFT')).toBe(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT)
    expect(sha256(teamingSystemPrompt('TEAMING_AGREEMENT_NDA_DRAFT'))).toBe(PINNED.TEAMING_AGREEMENT_NDA_DRAFT.sha256)
    expect(sha256(teamingSystemPrompt('PARTNER_OUTREACH_DRAFT'))).toBe(PINNED.PARTNER_OUTREACH_DRAFT.sha256)
  })

  it('is frozen, so no caller can mutate a prompt at runtime', () => {
    expect(Object.isFrozen(TEAMING_PROMPTS)).toBe(true)
    expect(Object.isFrozen(TEAMING_PROMPTS.TEAMING_AGREEMENT_NDA_DRAFT)).toBe(true)
    expect(Object.isFrozen(TEAMING_PROMPTS.PARTNER_OUTREACH_DRAFT)).toBe(true)
  })

  it('declares each prompt literal exactly once in the teaming directory', () => {
    const dir = __dirname
    const opener = 'You are the Teaming Agreement and NDA Drafting Assistant inside Bytescon.'
    const openerB = 'You are the Partner Outreach Drafting Assistant inside Bytescon.'
    let a = 0
    let b = 0
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))) {
      const content = readFileSync(join(dir, file), 'utf8')
      if (content.includes(opener)) a += 1
      if (content.includes(openerB)) b += 1
    }
    expect(a, 'agreement/NDA prompt must live in exactly one module').toBe(1)
    expect(b, 'outreach prompt must live in exactly one module').toBe(1)
  })

  it('is never concatenated with extra system instructions by any caller', () => {
    const dir = __dirname
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))) {
      const content = readFileSync(join(dir, file), 'utf8')
      // A caller may pass the constant; it may never build on top of it.
      expect(/TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT\s*\+/.test(content), file).toBe(false)
      expect(/PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT\s*\+/.test(content), file).toBe(false)
      expect(/\$\{TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT\}/.test(content), file).toBe(false)
      expect(/\$\{PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT\}/.test(content), file).toBe(false)
    }
  })

  it('does not redeclare the §5.1 teaming-agreement prompt that already exists', () => {
    // `services/teamingAgreementDraft.ts` owns TEAMING_AGREEMENT_SYSTEM_PROMPT.
    // §7.5 adds two NEW prompts and must not touch or duplicate that one.
    const existing = readFileSync(
      join(__dirname, '..', '..', 'teamingAgreementDraft.ts'),
      'utf8',
    )
    expect(existing).toContain('export const TEAMING_AGREEMENT_SYSTEM_PROMPT')
    expect(existing).not.toContain('TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT')
  })
})
