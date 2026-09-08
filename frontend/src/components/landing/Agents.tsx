// =============================================================
// Agents — the figure stays pinned while the nine agents scroll past it,
// each row rising in turn with a gold sweep across its hairline.
// =============================================================
import { SectionHeading } from './shared'
import { Stagger, StaggerItem, Aperture, Parallax } from './motion'

export const AGENTS = [
  { name: 'Opportunity', role: 'Finds and ranks what is worth pursuing', cadence: 'every 2h' },
  { name: 'Qualification', role: 'Bid or no-bid, with the reasoning shown', cadence: 'every 6h' },
  { name: 'Compliance', role: 'Matrices that survive every amendment', cadence: 'every 6h' },
  { name: 'Proposal', role: 'Outlines and drafts, approved by a human', cadence: 'every 6h' },
  { name: 'Pricing', role: 'Benchmarked against public award data', cadence: 'every 12h' },
  { name: 'Teaming', role: 'Partners proposed with evidence', cadence: 'daily 03:00' },
  { name: 'Contract Administration', role: 'Deliverables, mods and options on time', cadence: 'daily 07:00' },
  { name: 'Finance', role: 'Invoices, receivables and cash flow', cadence: 'daily 08:00' },
  { name: 'Intelligence', role: 'Where the firm actually wins', cadence: 'weekly' },
]

export function Agents() {
  return (
    <section id="agents" className="lp-dark py-24 lg:py-36">
      <div className="lp-container grid items-start gap-16 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-24">
        <div className="order-last lg:order-first lg:sticky lg:top-28">
          <Aperture className="lp-figure-wrap">
            <Parallax speed={0.1}>
              <figure className="lp-figure">
                <img src="/landing/agents.jpg" alt="A single eagle feather sculpted from blue glass and gold light" loading="lazy" decoding="async" />
                <figcaption className="lp-figure-caption">Nine agents, one audit trail</figcaption>
              </figure>
            </Parallax>
          </Aperture>
        </div>

        <div>
          <SectionHeading
            eyebrow="Agents"
            title={<>Nine agents. <span className="lp-italic">No black boxes.</span></>}
            sub="Every agent is opt-in and runs without an AI key. The two that draft use a model only when you enable it, and always hand the result to a person."
          />
          <Stagger as="ol" className="mt-12" stagger={0.07} amount={0.05}>
            {AGENTS.map((a, i) => (
              <StaggerItem as="li" key={a.name} className="lp-agent lp-sweep">
                <span className="lp-mono" style={{ color: 'var(--lp-gold-2)' }}>0{i + 1}</span>
                <div className="min-w-0">
                  <h3 className="lp-agent-name">{a.name}</h3>
                  <p className="lp-muted text-sm">{a.role}</p>
                </div>
                <span className="lp-mono" style={{ color: 'var(--lp-dim)' }}>{a.cadence}</span>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </div>
    </section>
  )
}
