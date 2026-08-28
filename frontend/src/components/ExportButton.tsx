// =============================================================
// One export control, so every table exports the same way.
//
// Disabled with a reason rather than hidden when there is nothing to export:
// a button that disappears reads as a missing feature, and someone goes
// looking for it. A greyed one with "nothing to export yet" answers the
// question where it was asked.
// =============================================================
import { Download } from 'lucide-react'
import { downloadCsv, type Column } from '../utils/exportTable'

interface Props<T> {
  rows: readonly T[]
  columns: ReadonlyArray<Column<T>>
  filename: string
  /**
   * What this button exports, in words — "funding ledger", "labour rates".
   *
   * A finance screen carries several of these and the visible text on all of
   * them is "CSV", which is fine to look at and useless to anyone reading the
   * page one control at a time. The visible label stays compact; the
   * accessible name says which table it belongs to.
   */
  what: string
  label?: string
}

export function ExportButton<T>({ rows, columns, filename, what, label = 'CSV' }: Props<T>) {
  const empty = rows.length === 0
  return (
    <button
      type="button"
      disabled={empty}
      aria-label={`Export ${what} as CSV`}
      title={empty ? `Nothing to export in ${what} yet` : `Export ${rows.length} row(s) of ${what} as CSV`}
      onClick={() => downloadCsv(rows, columns, filename)}
      className="text-[11px] px-2 py-1 rounded border border-gray-700 text-gray-400 inline-flex items-center gap-1.5
                 hover:text-gray-200 hover:border-gray-600 transition-colors
                 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-gray-400 disabled:hover:border-gray-700">
      <Download className="w-3 h-3" />
      {label}
      {!empty && <span className="text-gray-600 font-mono">{rows.length}</span>}
    </button>
  )
}
