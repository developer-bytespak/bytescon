// =============================================================
// Agents — the nine opt-in agents on one dark surface, each with what it
// does and how often it runs.
// =============================================================
import { Rise, Stagger, StaggerItem } from './motion'

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
    <section id="agents" className="lp-container py-4">
      <div className="lp-surface lp-surface-night grid gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-20" style={{ padding: 'clamp(28px, 4.5vw, 56px)' }}>
        <div className="lg:sticky lg:top-28 lg:self-start">
          <Rise>
            <h2 className="lp-h2" style={{ color: '#f0f1fa' }}>Nine agents. No black boxes.</h2>
          </Rise>
          <Rise delay={80}>
            <p className="mt-5 max-w-md text-[18px] leading-[28px]" style={{ color: 'rgba(240, 241, 250, 0.7)' }}>
              Every agent is opt-in and runs without an AI key. The two that draft use a model only when you enable it, and always hand the result to a person.
            </p>
          </Rise>
        </div>

        <Stagger as="ol" className="lp-rule-list" stagger={0.05} amount={0.05}>
          {AGENTS.map((a) => (
            <StaggerItem as="li" key={a.name} className="lp-agent">
              <div className="min-w-0">
                <h3 className="lp-agent-name">{a.name}</h3>
                <p className="mt-0.5 text-sm" style={{ color: 'rgba(240, 241, 250, 0.6)' }}>{a.role}</p>
              </div>
              <span className="lp-num text-[13px]" style={{ color: 'rgba(240, 241, 250, 0.6)' }}>{a.cadence}</span>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  )
}
