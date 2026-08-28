// =============================================================
// §6.1A — Adapter registration.
//
// Importing this module registers every built-in adapter exactly once. Routes,
// workers and tests import from here rather than reaching into individual
// adapter files, so the registry is always fully populated.
//
// Live status per adapter is NOT declared here — it is earned. sourceSync sets
// verification = LIVE_VERIFIED only after a real successful provider run.
// =============================================================
import { registerAdapter, listAdapters, SourceAdapter } from '../sourceAdapter'
import { samGovAdapter } from './samGovAdapter'
import { awardHistoryAdapter } from './awardHistoryAdapter'
import { agencyForecastAdapter } from './agencyForecastAdapter'
import { grantsGovAdapter } from './grantsGovAdapter'
import { stateLocalAdapter } from './stateLocalAdapter'
import { subcontractingBoardAdapter } from './subcontractingBoardAdapter'

const BUILT_IN: SourceAdapter[] = [
  samGovAdapter,
  awardHistoryAdapter,
  agencyForecastAdapter,
  grantsGovAdapter,
  stateLocalAdapter,
  subcontractingBoardAdapter,
]

let registered = false

export function registerBuiltInAdapters(): SourceAdapter[] {
  if (!registered) {
    BUILT_IN.forEach(registerAdapter)
    registered = true
  }
  return listAdapters()
}

/** Test-only: allows a suite to re-register after resetRegistryForTests(). */
export function forceReregisterForTests(): void {
  registered = false
  registerBuiltInAdapters()
}

registerBuiltInAdapters()

export { BUILT_IN }
