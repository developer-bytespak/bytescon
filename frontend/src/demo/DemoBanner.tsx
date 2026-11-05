import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { demoApi } from './demoApi'
import { isDemoSite } from './demoMode'
import { startDemoTour } from './demoTour'

const DAY = 86_400_000

export function daysLeft(expiresAt: string, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / DAY))
}

/** Always on screen inside the demo: how long is left, and the tour. */
export function DemoBanner() {
  const { data } = useQuery({ queryKey: ['demo-status'], queryFn: demoApi.status, enabled: isDemoSite })
  if (!isDemoSite) return null
  const left = data?.expiresAt ? daysLeft(data.expiresAt) : null
  return (
    <div
      role="status"
      data-testid="demo-banner"
      className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4 py-1.5 text-center text-xs font-medium"
      style={{ background: '#1e3a8a', color: '#ffffff' }}
    >
      {left !== null && <span>{left} {left === 1 ? 'day' : 'days'} left</span>}
      <button type="button" onClick={startDemoTour} className="underline underline-offset-2">
        Take the tour
      </button>
      {data?.isOperator && (
        <Link to="/demo-admin" className="underline underline-offset-2">
          Demo accounts
        </Link>
      )}
    </div>
  )
}
