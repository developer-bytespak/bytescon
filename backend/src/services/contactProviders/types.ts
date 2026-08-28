// =============================================================
// Contact Provider abstraction
//
// Each provider takes a UEI (plus optional legalName / website hints
// for providers that key on domain) and returns a normalized list of
// contacts. Adding Apollo / Hunter / PDL later = drop a new file in
// this folder and register it in ./index.ts. Frontend doesn't care
// which source ran.
// =============================================================

export interface ContactRow {
  name: string | null
  title: string | null
  email: string | null
  phone: string | null
  /** Provider-specific tag for UI display, e.g. 'sam.gov' or 'apollo'. */
  source: string
  /** Free-form role label, e.g. 'government_business', 'CTO'. Provider-defined. */
  role?: string | null
  /**
   * GB-104 — provider's confidence in the email's correctness. Providers
   * that can confirm deliverability set 'verified'; authoritative-but-
   * unconfirmed sources (e.g. a SAM.gov registered POC) set 'probable';
   * omit when no email is present. The composer maps this to the draft's
   * emailVerificationStatus, which gates auto-send.
   */
  verificationStatus?: 'verified' | 'probable' | 'unknown'
  /** Optional 0-1 confidence where the provider supplies one. */
  confidence?: number | null
}

export interface FetchContactsArgs {
  uei: string
  legalName: string | null
  website: string | null
}

export interface ContactProvider {
  /** Stable key persisted on RecipientProfile.contactsProvider. */
  key: string
  /** Human-readable name for UI. */
  label: string
  /** True if the provider can run with no extra config (e.g., env var). */
  isAvailable(): boolean
  fetchContacts(args: FetchContactsArgs): Promise<ContactRow[]>
}
