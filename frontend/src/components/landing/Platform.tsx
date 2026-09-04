// =============================================================
// Platform — three typographic claims, no boxes, plus one line each on
// the Claude/MCP connection and security posture.
// =============================================================
import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { Reveal, SectionHeading } from './shared'

const CLAIMS = [
  { accent: <>71<i>%</i></>, title: 'Win probability you can defend', text: 'Eight weighted factors, recalibrated against each client\'s real outcomes. When it says 60%, it has earned the right to.' },
  { accent: <><i>L</i>&amp;<i>M</i></>, title: 'A compliance matrix in minutes', text: 'Sections L and M mapped to requirements, FAR and DFARS clauses flagged, gaps turned into bid guidance.' },
  { accent: <>Your <i>brand</i></>, title: 'Every deliverable carries your firm', text: 'Client portals and PDF reports with your logo and colours. Many clients, one workspace, no crossed data.' },
]

export function Platform() {
  return (
    <section id="platform" className="lp-light py-24 lg:py-36">
      <div className="lp-container">
        <SectionHeading
          eyebrow="Platform"
          title={<>Built for firms with <span className="lp-italic">many</span> clients, not one.</>}
        />

        <div className="mt-16 grid gap-12 md:grid-cols-3 md:gap-10">
          {CLAIMS.map((c, i) => (
            <Reveal key={c.title} delay={i * 110} className="border-t border-[var(--lp-line-light)] pt-8">
              <p className="lp-accent-big">{c.accent}</p>
              <h3 className="lp-display mt-6 text-2xl">{c.title}</h3>
              <p className="lp-muted mt-3 text-[15px] leading-relaxed">{c.text}</p>
            </Reveal>
          ))}
        </div>

        <Reveal delay={200} className="mt-20 grid gap-8 border-t border-[var(--lp-line-light)] pt-8 md:grid-cols-2">
          <div>
            <p className="lp-eyebrow">Ask it from Claude</p>
            <p className="lp-muted mt-3 max-w-md text-[15px] leading-relaxed">
              MCP tokens connect Bytescon to Claude and other AI tools. Ask which SDVOSB bids close this week and get the scored list back.
            </p>
          </div>
          <div>
            <p className="lp-eyebrow">Security</p>
            <p className="lp-muted mt-3 max-w-md text-[15px] leading-relaxed">
              Tenant isolation, AES-256-GCM at rest, MFA on every seat and an exportable audit trail. SOC 2 and CMMC Level 2 mapping is in progress.
            </p>
            <Link to="/trust" className="lp-link mt-4">Read the trust page <ArrowUpRight className="h-4 w-4" /></Link>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
