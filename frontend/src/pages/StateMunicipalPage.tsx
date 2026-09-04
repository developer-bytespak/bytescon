import { Link } from 'react-router-dom'
import { MapPin, Clock, CheckCircle, ArrowRight } from 'lucide-react'
import { PageHeader } from '../components/ui'

const COMING_SOON_FEATURES = [
  'Live solicitation feeds from TX, FL, GA, TN, NC, AZ, IN, OH, SC, NV',
  'Bulk import from any state portal export (CSV / Excel)',
  'Agency-grouped view with collapse/expand',
  'Win probability scoring at the state level',
  'Deadline tracking and email alerts',
  'Subcontracting opportunity matching by state',
]

export function StateMunicipalPage() {
  return (
    <div>
      <PageHeader
        title="State & Municipal Pipeline"
        subtitle="State, county, and municipal government contracts"
      />

      <div className="flex flex-col items-center justify-center py-20 gap-6 max-w-lg mx-auto text-center">
        <div className="w-16 h-16 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
          <Clock className="w-8 h-8 text-amber-400" />
        </div>

        <div>
          <h2 className="text-2xl font-semibold text-gray-100 mb-2">Coming Soon</h2>
          <p className="text-gray-400 text-sm leading-relaxed">
            State &amp; Municipal contract tracking is under active development.
            In the meantime, your federal pipeline is live and ready.
          </p>
        </div>

        <Link
          to="/opportunities"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold text-black"
          style={{ background: 'linear-gradient(90deg,#7b8fff,#5b74ff)' }}
        >
          Browse federal opportunities
          <ArrowRight className="w-4 h-4" />
        </Link>

        <div className="w-full bg-gray-800/60 border border-gray-700 rounded-xl p-5 text-left space-y-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide flex items-center gap-2">
            <MapPin className="w-3.5 h-3.5 text-amber-400" /> What's being built
          </p>
          {COMING_SOON_FEATURES.map((f, i) => (
            <div key={i} className="flex items-start gap-2.5 text-sm text-gray-300">
              <CheckCircle className="w-4 h-4 text-amber-400/60 flex-shrink-0 mt-0.5" />
              {f}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
