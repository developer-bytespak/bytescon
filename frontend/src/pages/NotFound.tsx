import { Link } from 'react-router-dom'
import { Home, Search } from 'lucide-react'

export default function NotFoundPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-6 p-4"
      style={{ background: 'var(--bg)' }}>
      <div className="text-center animate-fade-up">
        <p className="font-display text-8xl mb-2 tabular-nums" style={{ color: 'var(--line-strong)' }}>404</p>
        <p className="text-2xl font-semibold text-slate-100 mb-2" style={{ letterSpacing: '-0.02em' }}>Page not found</p>
        <p className="text-slate-500 text-sm mb-8">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="flex flex-wrap items-center gap-3 justify-center">
          <Link
            to="/dashboard"
            className="btn-primary !px-5 !py-2.5"
          >
            <Home className="w-4 h-4" />
            Dashboard
          </Link>
          <Link
            to="/opportunities"
            className="btn-secondary !px-5 !py-2.5"
          >
            <Search className="w-4 h-4" />
            Opportunities
          </Link>
        </div>
      </div>
    </div>
  )
}
