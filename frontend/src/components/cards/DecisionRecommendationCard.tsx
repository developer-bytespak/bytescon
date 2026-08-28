import { Link } from 'react-router-dom'
import { Scale, ThumbsUp, ThumbsDown, MinusCircle } from 'lucide-react'
import { formatCurrency } from '../ui'

interface Decision {
  id: string
  recommendation: string
  winProbability: number
  expectedValue: number
  complianceStatus: string
  riskScore: number
  opportunity: { id: string; title: string; agency: string }
  clientCompany: { id: string; name: string }
}

const recStyles: Record<string, { bg: string; text: string; icon: any; label: string }> = {
  BID_PRIME: { bg: 'bg-green-900/30', text: 'text-green-400', icon: ThumbsUp, label: 'BID PRIME' },
  BID_SUB: { bg: 'bg-blue-900/30', text: 'text-blue-400', icon: Scale, label: 'BID SUB' },
  NO_BID: { bg: 'bg-red-900/30', text: 'text-red-400', icon: ThumbsDown, label: 'NO BID' },
}

const complianceStyles: Record<string, string> = {
  APPROVED: 'bg-green-900 text-green-300',
  PENDING: 'bg-yellow-900 text-yellow-300',
  BLOCKED: 'bg-red-900 text-red-300',
  REJECTED: 'bg-gray-700 text-gray-400',
}

export function DecisionRecommendationCard({ decisions }: { decisions?: Decision[] }) {
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-4">
        <Scale className="w-4 h-4 text-blue-400" />
        <h3 className="font-semibold text-gray-200">Recent Decisions</h3>
      </div>

      <div className="space-y-2 max-h-80 overflow-y-auto">
        {!decisions || decisions.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-4">No decisions yet</p>
        ) : (
          decisions.map((d) => {
            const style = recStyles[d.recommendation] || recStyles.NO_BID
            const Icon = style.icon
            return (
              <div key={d.id} className={`rounded-md p-3 ${style.bg} border border-gray-700`}>
                <div className="flex items-start gap-2">
                  <Icon className={`w-4 h-4 mt-0.5 ${style.text} flex-shrink-0`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className={`text-xs font-bold ${style.text}`}>{style.label}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                          complianceStyles[d.complianceStatus] || 'bg-gray-700 text-gray-400'
                        }`}
                      >
                        {d.complianceStatus}
                      </span>
                    </div>
                    <Link
                      to={`/opportunities/${d.opportunity.id}`}
                      className="text-xs text-blue-400 hover:text-blue-300 line-clamp-1 block"
                    >
                      {d.opportunity.title}
                    </Link>
                    <p className="text-[11px] text-gray-500 mt-0.5">
                      {d.clientCompany.name} &middot; {d.opportunity.agency}
                    </p>
                    <div className="flex items-center gap-3 mt-1.5 text-[11px] text-gray-400">
                      <span>Win: {Math.round(d.winProbability * 100)}%</span>
                      <span>EV: {formatCurrency(d.expectedValue)}</span>
                      {d.riskScore > 0 && (
                        <span className="text-red-400">Risk: {d.riskScore}</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
