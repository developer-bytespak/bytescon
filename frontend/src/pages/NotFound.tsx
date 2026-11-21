import { Link } from 'react-router-dom'
import { Home, Search } from 'lucide-react'
import { AuthShell } from '../components/auth/AuthShell'

export default function NotFoundPage() {
  return (
    <AuthShell>
      <div className="text-center">
        <p className="v3-figure tabular-nums" style={{ color: 'var(--text-dim)' }}>404</p>
        <h1 className="mt-5 text-[28px] leading-[34px] font-semibold tracking-[-0.03em]" style={{ color: 'var(--text)' }}>Page not found</h1>
        <p className="mt-2 mb-8 text-[15px] leading-[22px]" style={{ color: 'var(--text-muted)' }}>
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="flex flex-wrap items-center gap-3 justify-center">
          <Link to="/dashboard" className="btn-primary">
            <Home className="w-4 h-4" aria-hidden="true" />
            Dashboard
          </Link>
          <Link to="/opportunities" className="btn-secondary">
            <Search className="w-4 h-4" aria-hidden="true" />
            Opportunities
          </Link>
        </div>
      </div>
    </AuthShell>
  )
}
