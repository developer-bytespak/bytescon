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
  ArrowLeft, BrainCircuit, Database, FileCheck2, Fingerprint,
  KeyRound, Lock, ScrollText, Server, Shield, ShieldCheck,
} from 'lucide-react'

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
  { name: 'Resend', purpose: 'Transactional email', note: 'Account and notification email delivery' },
  { name: 'Twilio', purpose: 'SMS alerts (optional)', note: 'Only if SMS notifications are enabled' },
]

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section
      className="rounded-xl p-6"
      style={{ background: 'rgba(19,19,24,0.7)', border: '1px solid rgba(236,232,223,0.144)' }}
    >
      <div className="flex items-center gap-2.5 mb-4">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: 'rgba(91,116,255,0.08)', border: '1px solid rgba(91,116,255,0.2)' }}
        >
          {icon}
        </div>
        <h2 className="text-base font-bold text-slate-100">{title}</h2>
      </div>
      {children}
    </section>
  )
}

function Item({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 text-cyan-500 flex-shrink-0">{icon}</div>
      <div>
        <p className="text-sm font-semibold text-slate-200">{title}</p>
        <p className="text-xs text-slate-400 leading-relaxed mt-0.5">{body}</p>
      </div>
    </div>
  )
}

export function TrustSecurityPage() {
  return (
    <div className="min-h-screen" style={{ background: '#0b0b0f' }}>
      <div className="max-w-4xl mx-auto px-6 py-12">
        {/* Header */}
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-cyan-400 transition-colors mb-8"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Bytescon
        </Link>

        <div className="flex items-center gap-3 mb-2">
          <ShieldCheck className="w-7 h-7 text-cyan-400" />
          <h1 className="text-3xl font-black text-slate-100" style={{ letterSpacing: '-0.02em' }}>
            Trust &amp; Security
          </h1>
        </div>
        <p className="text-sm text-slate-400 mb-1">
          How Bytescon protects your firm's data, your clients' data, and your proposals.
        </p>
        <p className="text-[11px] text-slate-600 font-mono mb-10">Last updated {LAST_UPDATED}</p>

        {/* Headline commitment */}
        <div
          className="rounded-xl p-6 mb-6"
          style={{ background: 'rgba(91,116,255,0.06)', border: '1px solid rgba(91,116,255,0.3)' }}
        >
          <div className="flex items-center gap-2.5 mb-3">
            <BrainCircuit className="w-5 h-5 text-cyan-400" />
            <h2 className="text-lg font-bold text-cyan-300">We do not train AI models on your data.</h2>
          </div>
          <div className="space-y-2 text-sm text-slate-300 leading-relaxed">
            <p>
              Your documents, proposals, client records, bid decisions, and pipeline never become
              training data — not for our models, and not for anyone else's.
            </p>
            <p className="text-xs text-slate-400">
              AI features send content to model providers only to fulfill your specific request
              (drafting a section, extracting requirements, scoring a fit). We use commercial APIs
              whose terms exclude training on submitted inputs, and every AI call your firm makes is
              recorded in your audit log.
            </p>
          </div>
        </div>

        <div className="space-y-6">
          {/* Data protection */}
          <Section icon={<Lock className="w-4 h-4 text-cyan-400" />} title="Data Protection">
            <div className="space-y-4">
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
          <Section icon={<BrainCircuit className="w-4 h-4 text-cyan-400" />} title="AI Governance">
            <div className="space-y-4">
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
          <Section icon={<Fingerprint className="w-4 h-4 text-cyan-400" />} title="Access Control">
            <div className="space-y-4">
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
          <Section icon={<Database className="w-4 h-4 text-cyan-400" />} title="Subprocessors & Data Sources">
            <p className="text-xs text-slate-400 mb-4 leading-relaxed">
              We keep the list of services that may process customer data deliberately short.
              Market intelligence is built from public government data (SAM.gov, USAspending.gov) —
              never from other customers' private data.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-widest text-slate-600">
                    <th className="py-2 pr-4">Service</th>
                    <th className="py-2 pr-4">Purpose</th>
                    <th className="py-2">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {SUBPROCESSORS.map((s) => (
                    <tr key={s.name} style={{ borderTop: '1px solid rgba(236,232,223,0.108)' }}>
                      <td className="py-2 pr-4 font-semibold text-slate-200 whitespace-nowrap">{s.name}</td>
                      <td className="py-2 pr-4 text-slate-400">{s.purpose}</td>
                      <td className="py-2 text-slate-500">{s.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* Compliance roadmap — honest framing */}
          <Section icon={<ShieldCheck className="w-4 h-4 text-cyan-400" />} title="Compliance Posture">
            <div className="space-y-2 text-xs text-slate-400 leading-relaxed">
              <p>
                Our controls — tenant isolation, audit logging, encryption, MFA, human-review gates —
                are built and verified in code today. We are mapping them to{' '}
                <span className="text-slate-300">SOC 2</span> and{' '}
                <span className="text-slate-300">NIST 800-171 / CMMC Level 2</span>; formal
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
        <div className="mt-8 text-center space-y-3">
          <p className="text-xs text-slate-500">
            Found a security issue? Email{' '}
            <a href="mailto:security@bytescon.com" className="text-cyan-400 hover:text-cyan-300">
              security@bytescon.com
            </a>{' '}
            — we take responsible disclosure seriously.
          </p>
          <p className="text-[10px] text-slate-800 tracking-widest">
            © {new Date().getFullYear()} BYTES PLATFORM · Bytescon · All Rights Reserved
          </p>
        </div>
      </div>
    </div>
  )
}
