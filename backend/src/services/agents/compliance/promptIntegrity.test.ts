// =============================================================
// §7.3 — Prompt integrity for the Compliance Agent.
//
// The §6 exactness test already pins the two system prompts to a hash. THIS
// test pins something different and equally important: that the Compliance
// Agent REFERENCES those canonical constants rather than keeping copies.
//
// A duplicated prompt would pass the §6 exactness test forever while the agent
// silently used its own drifting variant. These assertions make that impossible:
// they compare object identity, and they read the compliance source directory to
// prove no prompt literal was pasted into it.
// =============================================================
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { describe, it, expect } from 'vitest'
import {
  SOLICITATION_EXTRACTION_SYSTEM_PROMPT,
  AMENDMENT_CHANGE_SUMMARY_SYSTEM_PROMPT,
  SOLICITATION_EXTRACTION_PROMPT_VERSION,
  AMENDMENT_SUMMARY_PROMPT_VERSION,
} from '../../requirements/extractionPrompts'
import {
  AMENDMENT_CHANGE_SUMMARY_SYSTEM_PROMPT as REEXPORTED_AMENDMENT_PROMPT,
  AMENDMENT_SUMMARY_PROMPT_VERSION as REEXPORTED_AMENDMENT_VERSION,
} from './amendmentRecheck'

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

/** Recorded before §7.3 was implemented and asserted unchanged after. */
const PINNED = {
  extraction: { sha256: '4220d8bc584227a3ef76adde08468554f3789bda429c576956f43a9c75ce4f80', length: 7264, bytes: 7268 },
  amendment: { sha256: '068a1832fab671cb3fc6807ff7aca1f37cc5f8a44f495b2bba0328657500f99d', length: 5337, bytes: 5339 },
}

const COMPLIANCE_DIR = __dirname

describe('§7.3 — the canonical prompts are unchanged', () => {
  it('leaves the solicitation extraction prompt byte-identical', () => {
    expect(sha256(SOLICITATION_EXTRACTION_SYSTEM_PROMPT)).toBe(PINNED.extraction.sha256)
    expect(SOLICITATION_EXTRACTION_SYSTEM_PROMPT.length).toBe(PINNED.extraction.length)
    expect(Buffer.byteLength(SOLICITATION_EXTRACTION_SYSTEM_PROMPT, 'utf8')).toBe(PINNED.extraction.bytes)
  })

  it('leaves the amendment change prompt byte-identical', () => {
    expect(sha256(AMENDMENT_CHANGE_SUMMARY_SYSTEM_PROMPT)).toBe(PINNED.amendment.sha256)
    expect(AMENDMENT_CHANGE_SUMMARY_SYSTEM_PROMPT.length).toBe(PINNED.amendment.length)
    expect(Buffer.byteLength(AMENDMENT_CHANGE_SUMMARY_SYSTEM_PROMPT, 'utf8')).toBe(PINNED.amendment.bytes)
  })

  it('leaves both prompt version tags unchanged', () => {
    expect(SOLICITATION_EXTRACTION_PROMPT_VERSION).toBe('section6-extraction-v1')
    expect(AMENDMENT_SUMMARY_PROMPT_VERSION).toBe('section6-amendment-v1')
  })

  it('preserves the typographic apostrophes §6 pinned', () => {
    expect(SOLICITATION_EXTRACTION_SYSTEM_PROMPT).toContain('the application’s document library')
    expect(AMENDMENT_CHANGE_SUMMARY_SYSTEM_PROMPT).toContain('another tenant’s data')
  })
})

describe('§7.3 — the Compliance Agent references, never copies', () => {
  it('re-exports the SAME string instance, not a duplicate', () => {
    // Identity, not equality: a pasted copy would be equal but not identical.
    expect(REEXPORTED_AMENDMENT_PROMPT).toBe(AMENDMENT_CHANGE_SUMMARY_SYSTEM_PROMPT)
    expect(REEXPORTED_AMENDMENT_VERSION).toBe(AMENDMENT_SUMMARY_PROMPT_VERSION)
  })

  it('stamps the canonical version tag rather than one of its own', () => {
    expect(REEXPORTED_AMENDMENT_VERSION).toBe('section6-amendment-v1')
  })

  it('contains no prompt literal anywhere in the compliance directory', () => {
    const sources = readdirSync(COMPLIANCE_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    expect(sources.length).toBeGreaterThan(0)

    // The opening line of each canonical prompt. Finding either inside the
    // compliance source would mean someone pasted a prompt in.
    const openings = [
      'You are the Solicitation Requirement, Section L/M, and Clause Mapping Assistant inside Bytescon.',
      'You are the Solicitation Amendment Change Analysis Assistant inside Bytescon.',
    ]
    for (const file of sources) {
      const content = readFileSync(join(COMPLIANCE_DIR, file), 'utf8')
      for (const opening of openings) {
        expect(content.includes(opening), `${file} must not contain a copy of a system prompt`).toBe(false)
      }
    }
  })

  it('declares no system prompt constant of its own', () => {
    const sources = readdirSync(COMPLIANCE_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    for (const file of sources) {
      const content = readFileSync(join(COMPLIANCE_DIR, file), 'utf8')
      // A re-export is allowed; a new declaration is not.
      expect(
        /export const \w*SYSTEM_PROMPT\w* =/.test(content),
        `${file} must not declare a system prompt constant — §7.3 introduces zero new prompts`,
      ).toBe(false)
    }
  })

  it('never appends agent instructions to a canonical prompt', () => {
    const sources = readdirSync(COMPLIANCE_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    for (const file of sources) {
      const content = readFileSync(join(COMPLIANCE_DIR, file), 'utf8')
      expect(
        /SYSTEM_PROMPT\s*\+|`\$\{[A-Z_]*SYSTEM_PROMPT\}/.test(content),
        `${file} must not concatenate anything onto a system prompt`,
      ).toBe(false)
    }
  })
})
