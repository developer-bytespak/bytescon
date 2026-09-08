// =============================================================
// Landing shared bits: section heading and brand mark. Motion primitives
// live in ./motion.tsx.
// =============================================================
import type { ReactNode } from 'react'
import { Rise } from './motion'

export function SectionHeading({ eyebrow, title, sub }: { eyebrow: string; title: ReactNode; sub?: ReactNode }) {
  return (
    <div className="max-w-2xl">
      <Rise><span className="lp-eyebrow">{eyebrow}</span></Rise>
      <Rise delay={90}>
        <h2 className="lp-display mt-5 text-[2.5rem] sm:text-5xl lg:text-[3.5rem]">{title}</h2>
      </Rise>
      {sub && (
        <Rise delay={180}>
          <p className="lp-muted mt-5 max-w-xl text-base leading-relaxed sm:text-lg">{sub}</p>
        </Rise>
      )}
    </div>
  )
}

export function BrandMark({ size = 30, id = 'lp-mark' }: { size?: number; id?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-g`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#f0d493" />
          <stop offset="100%" stopColor="#d3a54a" />
        </linearGradient>
      </defs>
      <path d="M12 6 L30 6 L48 32 L30 58 L12 58 L27 32 Z" fill={`url(#${id}-g)`} />
      <path d="M37 12 L45 12 L59 32 L45 52 L37 52 L51 32 Z" fill="#8c9cff" opacity="0.85" />
    </svg>
  )
}
