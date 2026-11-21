// =============================================================
// Trust & Security — public (unauthenticated) page. FIX-3.
//
// The security-questionnaire front door: states the platform's data
// handling and security posture in plain language, headlined by the
// explicit "we do not train AI models on your data" commitment.
// Every claim on this page maps to shipped, verifiable behavior —
// compliance certifications that are roadmap items are labeled as such.
// =============================================================
import { Link } from 'react-router-dom'
import {
  ArrowLeft, FileCheck2, Fingerprint,
  KeyRound, ScrollText, Server, Shield, ShieldCheck,
} from 'lucide-react'
import { Wordmark } from '../components/auth/AuthShell'

const LAST_UPDATED = 'July 1, 2026'

const SUBPROCESSORS: { name: string; purpose: string; note: string }[] = [
  { name: 'Render', purpose: 'Cloud hosting (US region)', note: 'Application servers and background workers' },
  { name: 'Vercel', purpose: 'Web hosting (US region)', note: 'Application front end' },
  { name: 'Neon', purpose: 'Managed PostgreSQL (US region)', note: 'Primary database, encrypted at rest' },
  { name: 'Anthropic', purpose: 'AI drafting & analysis', note: 'Commercial API — inputs not used to train models' },
  { name: 'OpenAI', purpose: 'AI drafting & analysis (optional)', note: 'Commercial API — inputs not used to train models' },
  { name: 'DeepSeek', purpose: 'AI analysis (optional, off by default)', note: 'Only if your firm supplies its own key' },
  { name: 'Stripe', purpose: 'Payments', note: 'Card data never touches our servers' },
  { name: 'Google BigQuery', purpose: 'Public market analytics', note: 'Public award data only — no customer documents' },
  { name: 'SendGrid (Twilio)', purpose: 'Transactional email', note: 'Account and notification email delivery' },
  { name: 'Twilio', purpose: 'SMS alerts (optional)', note: 'Only if SMS notifications are enabled' },
]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="v3-surface">
      <h2 className="v3-h3 mb-5" style={{ color: 'var(--text)' }}>{title}</h2>
      {children}
    </section>
  )
}

function Item({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex items-start gap-4 py-4 first:pt-0 last:pb-0">
      <div className="mt-0.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} aria-hidden="true">{icon}</div>
      <div>
        <p className="text-[15px] font-semibold" style={{ color: 'var(--text)' }}>{title}</p>
        <p className="text-sm leading-[21px] mt-1" style={{ color: 'var(--text-muted)' }}>{body}</p>
      </div>
    </div>
  )
}

export function TrustSecurityPage() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <header className="flex items-center justify-between gap-4 px-5 sm:px-10 pt-6">
        <Wordmark />
        <Link to="/" className="v3-pill v3-pill-light v3-pill-sm">
          <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" /> Back to Bytesgov
        </Link>
      </header>
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12">
        <h1 className="v3-h1" style={{ color: 'var(--text)' }}>Trust and security</h1>
        <p className="v3-lede mt-4" style={{ color: 'var(--text-muted)' }}>
          How Bytesgov protects your firm's data, your clients' data, and your proposals.
        </p>
        <p className="text-[13px] mt-3 mb-10" style={{ color: 'var(--text-dim)' }}>Last updated {LAST_UPDATED}</p>

        {/* Headline commitment */}
        <div className="v3-surface v3-surface-night mb-4" style={{ padding: 'clamp(28px, 4vw, 40px)' }}>
          <h2 className="v3-h2" style={{ color: '#f0f1fa' }}>We do not train AI models on your data.</h2>
          <div className="mt-4 space-y-3 text-[15px] leading-[23px] max-w-[64ch]">
            <p style={{ color: 'rgba(240, 241, 250, 0.85)' }}>
              Your documents, proposals, client records, bid decisions, and pipeline never become
              training data — not for our models, and not for anyone else's.
            </p>
            <p className="v3-muted text-sm leading-[21px]">
              AI features send content to model providers only to fulfill your specific request
              (drafting a section, extracting requirements, scoring a fit). We use commercial APIs
              whose terms exclude training on submitted inputs, and every AI call your firm makes is
              recorded in your audit log.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          {/* Data protection */}
          <Section title="Data protection">
            <div className="v3-rule-list">
              <Item
                icon={<Shield className="w-4 h-4" />}
                title="Strict tenant isolation"
                body="Every request is scoped to your firm at the middleware layer — no query runs without your tenant ID. Cross-tenant isolation is covered by automated regression tests that run on every change."
              />
              <Item
                icon={<KeyRound className="w-4 h-4" />}
                title="Encryption in transit and at rest"
                body="All traffic is TLS-encrypted. Stored credentials and connected API keys are encrypted at rest with AES-256-GCM."
              />
              <Item
                icon={<ScrollText className="w-4 h-4" />}
                title="Complete, exportable audit trail"
                body="Creates, updates, deletes, exports, downloads, approvals, and every AI inference are written to a per-firm audit log. Firm admins can export the full trail to CSV at any time for their own compliance reviews."
              />
            </div>
          </Section>

          {/* AI governance */}
          <Section title="AI governance">
            <div className="v3-rule-list">
              <Item
                icon={<FileCheck2 className="w-4 h-4" />}
                title="Human-in-the-loop attestation on proposals"
                body="Every AI-drafted proposal carries a DRAFT — NOT FOR SUBMISSION banner until a named person reviews it and attests to its accuracy. The attestation is pinned to a cryptographic hash of the draft: if the content changes, the attestation goes stale and export re-locks."
              />
              <Item
                icon={<ShieldCheck className="w-4 h-4" />}
                title="De-identification review on shared templates"
                body="Documents shared to the cross-firm template library are held for review and require an explicit human confirmation that client-identifying information has been removed before any other firm can see them."
              />
              <Item
                icon={<Server className="w-4 h-4" />}
                title="No single-vendor lock-in"
                body="A multi-provider AI router lets your firm choose its provider (or bring its own key), so your workflow never depends on a single model vendor."
              />
            </div>
          </Section>

          {/* Access control */}
          <Section title="Access control">
            <div className="v3-rule-list">
              <Item
                icon={<Fingerprint className="w-4 h-4" />}
                title="Two-factor authentication (TOTP)"
                body="Any user can enable authenticator-app 2FA with recovery codes. Login and sensitive account actions are rate-limited per account."
              />
              <Item
                icon={<KeyRound className="w-4 h-4" />}
                title="Role-based, least-privilege access"
                body="Admin-only writes, read-only member roles, and single-purpose scoped tokens that are rejected on all data routes."
              />
            </div>
          </Section>

          {/* Subprocessors */}
          <Section title="Subprocessors and data sources">
            <p className="text-sm mb-5 leading-[21px]" style={{ color: 'var(--text-muted)' }}>
              We keep the list of services that may process customer data deliberately short.
              Market intelligence is built from public government data (SAM.gov, USAspending.gov) —
              never from other customers' private data.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>
                    <th className="py-2 pr-4">Service</th>
                    <th className="py-2 pr-4">Purpose</th>
                    <th className="py-2">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {SUBPROCESSORS.map((s) => (
                    <tr key={s.name} style={{ borderTop: '1px solid var(--line)' }}>
                      <td className="py-2.5 pr-4 font-semibold whitespace-nowrap" style={{ color: 'var(--text)' }}>{s.name}</td>
                      <td className="py-2.5 pr-4" style={{ color: 'var(--text-2)' }}>{s.purpose}</td>
                      <td className="py-2.5" style={{ color: 'var(--text-muted)' }}>{s.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* Compliance roadmap — honest framing */}
          <Section title="Compliance posture">
            <div className="space-y-3 text-sm leading-[21px]" style={{ color: 'var(--text-muted)' }}>
              <p>
                Our controls — tenant isolation, audit logging, encryption, MFA, human-review gates —
                are built and verified in code today. We are mapping them to{' '}
                <span style={{ color: 'var(--text)' }}>SOC 2</span> and{' '}
                <span style={{ color: 'var(--text)' }}>NIST 800-171 / CMMC Level 2</span>; formal
                third-party attestation is on our roadmap and this page will be updated as
                milestones land.
              </p>
              <p>
                Working through a security questionnaire? We're happy to walk your team through the
                platform's architecture and answer it directly.
              </p>
            </div>
          </Section>
        </div>

        {/* Contact + footer */}
        <div className="mt-10 text-center space-y-3">
          <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
            Found a security issue? Email{' '}
            <a href="mailto:security@bytescon.com" className="font-semibold underline underline-offset-2" style={{ color: 'var(--text)' }}>
              security@bytescon.com
            </a>{' '}
            — we take responsible disclosure seriously.
          </p>
          <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
            © {new Date().getFullYear()} Bytes Platform · Bytesgov · All rights reserved
          </p>
        </div>
      </div>
    </div>
  )
}
