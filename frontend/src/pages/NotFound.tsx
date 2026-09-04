import { Link } from 'react-router-dom'
import { Home, Search } from 'lucide-react'

export default function NotFoundPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-6"
      style={{ background: '#0b0b0f' }}>
      <div className="text-center">
        <p className="text-8xl font-black text-amber-400/20 mb-2">404</p>
        <p className="text-2xl font-bold text-slate-100 mb-2">Page not found</p>
        <p className="text-slate-500 text-sm mb-8">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="flex items-center gap-3 justify-center">
          <Link
            to="/dashboard"
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold text-black"
            style={{ background: 'linear-gradient(90deg,#7b8fff,#5b74ff)' }}
          >
            <Home className="w-4 h-4" />
            Dashboard
          </Link>
          <Link
            to="/opportunities"
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold text-slate-300 border border-slate-700 hover:border-amber-500/40 transition-colors"
          >
            <Search className="w-4 h-4" />
            Opportunities
          </Link>
        </div>
      </div>
    </div>
  )
}
