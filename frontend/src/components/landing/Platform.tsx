// =============================================================
// Platform — three claims, each led by a large figure, then two notes on
// AI access and security.
// =============================================================
import { Link } from 'react-router-dom'
import { SectionHeading } from './shared'
import { Rise, Stagger, StaggerItem } from './motion'

const CLAIMS = [
  { accent: '71%', title: 'Win probability you can defend', text: 'Eight weighted factors, recalibrated against each client\'s real outcomes. When it says 60%, it has earned the right to.' },
  { accent: 'L and M', title: 'A compliance matrix in minutes', text: 'Sections L and M mapped to requirements, FAR and DFARS clauses flagged, gaps turned into bid guidance.' },
  { accent: 'Your brand', title: 'Every deliverable carries your firm', text: 'Client portals and PDF reports with your logo and colours. Many clients, one workspace, no crossed data.' },
]

export function Platform() {
  return (
    <section id="platform" className="lp-container py-20 lg:py-28">
      <SectionHeading title="Built for firms with many clients, not one." />

      <Stagger className="mt-12 grid gap-4 md:grid-cols-3" stagger={0.08}>
        {CLAIMS.map((c) => (
          <StaggerItem key={c.title} className="lp-surface h-full">
            <p className="lp-accent-big">{c.accent}</p>
            <h3 className="lp-h3 mt-10">{c.title}</h3>
            <p className="lp-muted mt-3 text-[15px] leading-[23px]">{c.text}</p>
          </StaggerItem>
        ))}
      </Stagger>

      <Rise delay={120} className="mt-4">
        <div className="lp-surface grid gap-8 md:grid-cols-2 md:gap-12">
          <div>
            <h3 className="lp-h3">Ask it from Claude</h3>
            <p className="lp-muted mt-3 max-w-md text-[15px] leading-[23px]">
              MCP tokens connect Bytesgov to Claude and other AI tools. Ask which SDVOSB bids close this week and get the scored list back.
            </p>
          </div>
          <div className="md:border-l md:pl-12" style={{ borderColor: 'var(--line)' }}>
            <h3 className="lp-h3">Security</h3>
            <p className="lp-muted mt-3 max-w-md text-[15px] leading-[23px]">
              Tenant isolation, AES-256-GCM at rest, MFA on every seat and an exportable audit trail. SOC 2 and CMMC Level 2 mapping is in progress.
            </p>
            <Link to="/trust" className="lp-link mt-4">Read the trust page</Link>
          </div>
        </div>
      </Rise>
    </section>
  )
}
