// =============================================================
// Landing shared bits: section heading and the "B." wordmark. Motion
// primitives live in ./motion.tsx.
// =============================================================
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Rise } from './motion'

/** A hairline rule above a plain heading, with an optional lede. */
export function SectionHeading({ title, sub, id }: { title: ReactNode; sub?: ReactNode; id?: string }) {
  return (
    <div className="lp-section-head max-w-3xl">
      <Rise>
        <h2 id={id} className="lp-h2">{title}</h2>
      </Rise>
      {sub && (
        <Rise delay={80}>
          <p className="lp-lede mt-4 max-w-2xl">{sub}</p>
        </Rise>
      )}
    </div>
  )
}

/** Ink "B" with a small electric-blue dot, as in the app rail. */
export function Wordmark({ withName = true }: { withName?: boolean }) {
  return (
    <Link to="/" className="lp-wordmark" aria-label="Bytesgov home">
      <b aria-hidden="true">B<i /></b>
      {withName && <span aria-hidden="true">Bytesgov</span>}
    </Link>
  )
}
