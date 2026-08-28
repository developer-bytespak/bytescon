import { AlertTriangle, ShieldAlert, Clock, DollarSign } from 'lucide-react'

interface RiskItem {
  entityType: string
  severity: 'CRITICAL' | 'HIGH' | 'MODERATE'
  title: string
  description: string
  entityId: string
  score: number
}

const severityStyles = {
  CRITICAL: 'border-red-500 bg-red-900/20',
  HIGH: 'border-orange-500 bg-orange-900/10',
  MODERATE: 'border-yellow-500 bg-yellow-900/10',
}

const severityBadge = {
  CRITICAL: 'bg-red-600 text-white',
  HIGH: 'bg-orange-600 text-white',
  MODERATE: 'bg-yellow-600 text-black',
}

const typeIcons: Record<string, any> = {
  DEADLINE: Clock,
  COMPLIANCE: ShieldAlert,
  PENALTY: DollarSign,
  LATE_RISK: AlertTriangle,
}

export function RiskRadarCard({ risks }: { risks?: RiskItem[] }) {
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-1">
        <AlertTriangle className="w-4 h-4 text-red-400" />
        <h3 className="font-semibold text-gray-200">Risk Radar</h3>
        {risks && risks.length > 0 && (
          <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-red-900 text-red-300">
            {risks.length} items
          </span>
        )}
      </div>

      <p className="text-xs text-gray-500 mb-3">
        Active risks across your client portfolio, ranked by severity. Each item flags a specific
        issue that could impact a submission, compliance standing, or contract performance.
      </p>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-3 pb-3 border-b border-gray-800">
        <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
          <Clock className="w-3 h-3 text-gray-400" /> <span>DEADLINE — submission window closing</span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
          <ShieldAlert className="w-3 h-3 text-gray-400" /> <span>COMPLIANCE — status block detected</span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
          <DollarSign className="w-3 h-3 text-gray-400" /> <span>PENALTY — unpaid penalties on record</span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
          <AlertTriangle className="w-3 h-3 text-gray-400" /> <span>LATE_RISK — elevated late submission probability</span>
        </div>
      </div>

      <div className="space-y-2 max-h-64 overflow-y-auto">
        {!risks || risks.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-4">No active risks</p>
        ) : (
          risks.slice(0, 8).map((risk, i) => {
            const Icon = typeIcons[risk.entityType] || AlertTriangle
            return (
              <div
                key={i}
                className={`border-l-2 rounded-r-md px-3 py-2 ${severityStyles[risk.severity]}`}
              >
                <div className="flex items-start gap-2">
                  <Icon className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-gray-400" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs font-medium text-gray-200 truncate">
                        {risk.title}
                      </span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${severityBadge[risk.severity]}`}
                      >
                        {risk.severity}
                      </span>
                    </div>
                    <p className="text-[11px] text-gray-400 line-clamp-2">
                      {risk.description}
                    </p>
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
