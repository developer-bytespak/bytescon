// =============================================================
// Clay — Contact Provider
//
// Enriches a recipient/prime with procurement contacts (name, title,
// email, phone, job function) from Clay (https://clay.com). (LinkedIn URLs
// are out of scope here — the shared ContactRow has no link field yet; see
// docs/contact-enrichment-phase1-port.md for the optional follow-up.)
// Implements the shared ContactProvider contract so it plugs into the
// existing recipientProfileService.enrichContacts() flow with zero
// changes to callers — exactly like samPocProvider.
//
// Why a direct REST client (not the spec's Anthropic-SDK + mcp_servers):
//   The amendment spec (C:/GovCon/Specs/...) proposes calling Clay through
//   `new Anthropic({...}).messages.create({ mcp_servers: [clay] })`. That
//   is rejected here because (1) CLAUDE.md mandates the existing llmRouter
//   and forbids calling the Claude API directly, (2) the llmRouter is
//   text-in/text-out and cannot carry mcp_servers/tool-use, and (3) it
//   would add @anthropic-ai/sdk, a dependency the codebase deliberately
//   avoids (ClaudeProvider hand-rolls raw fetch). The established, testable
//   pattern is a ContactProvider over a plain HTTP call — what this file is.
//
// Safety (GB-104): a contact's email is only marked 'verified' when Clay
// returns an explicit deliverability signal (emailStatus = valid/deliverable/
// verified). Otherwise it is 'probable' (email present) or 'unknown' — the
// same discipline samPocProvider uses to keep auto-send
// honest. This overrides the spec's blanket verificationStatus:'verified'.
//
// Gated OFF by default behind CLAY_ENRICHMENT_ENABLED + CLAY_API_KEY.
//
// NOTE — Clay request/response shape: Clay's enrichment surface is
// table/MCP/webhook-oriented, so the exact REST contract depends on how the
// account exposes it (a published Clay table webhook, or Clay's HTTP API).
// The request builder and response mapper below are isolated, pure, and
// tolerant of missing fields; point CLAY_BASE_URL at the real endpoint and
// adjust buildClayEnrichRequest/mapClayResponseToContacts to the confirmed
// payload before enabling in production. The provider stays flag-gated off
// until then, so this is a wiring foundation, not a live integration.
// =============================================================

import axios from 'axios'
import { logger } from '../../utils/logger'
import type { ContactProvider, ContactRow, FetchContactsArgs } from './types'

const SOURCE = 'clay'
const DEFAULT_BASE_URL = 'https://api.clay.com/v3'
const REQUEST_TIMEOUT_MS = 30000

/** Feature gate — default OFF. */
export function isClayEnrichmentEnabled(): boolean {
  const raw = (process.env.CLAY_ENRICHMENT_ENABLED || '').toLowerCase().trim()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

function clayApiKey(): string {
  return (process.env.CLAY_API_KEY || '').trim()
}

function clayBaseUrl(): string {
  return (process.env.CLAY_BASE_URL || '').trim() || DEFAULT_BASE_URL
}

// ── Pure helpers (unit-tested with no network) ───────────────────

function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim()
    return t.length ? t : null
  }
  return null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Build the enrichment request body Clay expects, from our provider args. */
export function buildClayEnrichRequest(args: FetchContactsArgs): Record<string, unknown> {
  return {
    // Clay keys enrichment on company identity; pass everything we have and
    // let the provider match on whatever is strongest (domain > name > uei).
    // Use || uniformly so empty strings drop to undefined, not sent as keys.
    companyName: args.legalName || undefined,
    domain: args.website || undefined,
    uei: args.uei || undefined,
    // Focus enrichment on procurement-relevant roles (see spec §2.2).
    roles: ['Procurement', 'Sourcing', 'Contracts', 'Business Development'],
  }
}

/**
 * Map a raw Clay enrichment response to normalized ContactRow[]. Tolerant of
 * shape: accepts a bare array or an object with a `contacts` array. Never
 * throws on malformed input — returns [] / skips bad rows. Dedupes by email.
 */
export function mapClayResponseToContacts(raw: unknown): ContactRow[] {
  const list = extractContactList(raw)
  const rows: ContactRow[] = []
  const seenEmails = new Set<string>()

  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>

    const name = extractName(c)
    const email = normalizeEmail(c.email)
    // Junk row — no way to act on it.
    if (!name && !email) continue

    if (email) {
      if (seenEmails.has(email)) continue
      seenEmails.add(email)
    }

    rows.push({
      name,
      title: str(c.jobTitle) ?? str(c.title),
      email,
      phone: str(c.phone),
      source: SOURCE,
      role: str(c.jobFunction) ?? str(c.role),
      verificationStatus: deriveVerificationStatus(email, c.emailStatus),
      confidence: num(c.sourceConfidence) ?? num(c.confidence),
    })
  }

  return rows
}

function extractContactList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    if (Array.isArray(obj.contacts)) return obj.contacts
    if (Array.isArray(obj.data)) return obj.data
    if (Array.isArray(obj.results)) return obj.results
  }
  return []
}

function extractName(c: Record<string, unknown>): string | null {
  const full = str(c.fullName) ?? str(c.name)
  if (full) return full
  const nameObj = c.name
  if (nameObj && typeof nameObj === 'object') {
    const n = nameObj as Record<string, unknown>
    const composed = str(n.full) ?? [str(n.first), str(n.last)].filter(Boolean).join(' ').trim()
    if (composed) return composed
  }
  const composed = [str(c.firstName), str(c.lastName)].filter(Boolean).join(' ').trim()
  return composed.length ? composed : null
}

function normalizeEmail(v: unknown): string | null {
  const e = str(v)
  if (!e) return null
  // Shape guard so a junk value (e.g. 'n/a') can never be promoted to a
  // 'verified' contact (GB-104). Require an '@' and a dotted domain.
  const lower = e.toLowerCase()
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lower) ? lower : null
}

/**
 * GB-104 discipline: only an explicit Clay deliverability signal earns
 * 'verified'. No email -> 'unknown'. Email present but unconfirmed ->
 * 'probable'. Explicitly invalid -> 'unknown' (don't trust it).
 */
export function deriveVerificationStatus(
  email: string | null,
  emailStatus: unknown,
): ContactRow['verificationStatus'] {
  if (!email) return 'unknown'
  const status = (str(emailStatus) ?? '').toLowerCase()
  if (status === 'valid' || status === 'deliverable' || status === 'verified') return 'verified'
  if (status === 'invalid' || status === 'undeliverable' || status === 'bounced') return 'unknown'
  return 'probable'
}

// ── Injectable HTTP seam (so tests stub the network) ─────────────

export type ClayHttpFn = (
  url: string,
  body: Record<string, unknown>,
  apiKey: string,
) => Promise<unknown>

const defaultClayHttp: ClayHttpFn = async (url, body, apiKey) => {
  const res = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT_MS,
  })
  return res.data
}

let clayHttp: ClayHttpFn = defaultClayHttp

/** Test seam: inject a stub HTTP fn; pass null to restore the axios default. */
export function __setClayHttpForTest(fn: ClayHttpFn | null): void {
  clayHttp = fn ?? defaultClayHttp
}

// ── Provider ─────────────────────────────────────────────────────

export const clayProvider: ContactProvider = {
  key: SOURCE,
  label: 'Clay Contact Enrichment',
  isAvailable() {
    return isClayEnrichmentEnabled() && clayApiKey().length > 0
  },
  async fetchContacts(args: FetchContactsArgs): Promise<ContactRow[]> {
    const apiKey = clayApiKey()
    if (!isClayEnrichmentEnabled() || !apiKey) return []

    const url = `${clayBaseUrl().replace(/\/+$/, '')}/enrich/contacts`
    try {
      const data = await clayHttp(url, buildClayEnrichRequest(args), apiKey)
      return mapClayResponseToContacts(data)
    } catch (err) {
      // A Clay outage must not break the enrichment pipeline — degrade to no
      // contacts (the consumer then falls back to other providers). Mirrors the
      // 'mark stale rather than fail hard' intent in the amendment spec §2.2.
      // NOTE: never log `err` / err.config / err.toJSON() directly — axios
      // attaches the Authorization header (Bearer CLAY_API_KEY) to err.config.
      // Log only message + status, as below.
      const status = (err as { response?: { status?: number } })?.response?.status
      logger.warn('Clay contact enrichment failed', {
        uei: args.uei,
        status: status ?? null,
        message: (err as Error)?.message,
      })
      return []
    }
  },
}
