// =============================================================
// §8.5 — Settings → Integrations.
//
// One page for external connections, agreements out for signature, single
// sign-on and access. Each tab is honest about what is actually configured.
// =============================================================
import { useState } from 'react'
import { PageHeader } from '../components/ui'
import { AccessSettings } from '../components/integrations/AccessSettings'
import { IntegrationCards } from '../components/integrations/IntegrationCards'
import { SsoSettings } from '../components/integrations/SsoSettings'
import { useTabParam } from '../hooks/useTabParam'

type TabKey = 'connections' | 'sso' | 'access'

const TABS: Array<[TabKey, string]> = [
  ['connections', 'Connections'],
  ['sso', 'Single sign-on'],
  ['access', 'Roles & access'],
]

export default function IntegrationsPage() {
  const [tab, setTab] = useTabParam(TABS.map(([key]) => key), 'connections')

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="Integrations & access"
        subtitle="External systems, agreements out for signature, single sign-on and who on your team can do what."
      />

      <div className="border-b border-gray-800 flex gap-1 flex-wrap">
        {TABS.map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-3 py-2 text-sm border-b-2 transition-colors ${
              tab === key ? 'border-amber-500 text-amber-400' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'connections' && <IntegrationCards />}
      {tab === 'sso' && <SsoSettings />}
      {tab === 'access' && <AccessSettings />}
    </div>
  )
}
