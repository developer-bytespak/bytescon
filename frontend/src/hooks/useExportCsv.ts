import { useCallback } from 'react'

export function useExportCsv() {
  const exportCsv = useCallback(
    (data: Record<string, any>[], filename: string) => {
      if (data.length === 0) return

      const headers = Object.keys(data[0])
      const rows = data.map((row) =>
        headers
          .map((h) => {
            const val = row[h]
            if (val == null) return ''
            const str = String(val)
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
              return `"${str.replace(/"/g, '""')}"`
            }
            return str
          })
          .join(',')
      )

      const csv = [headers.join(','), ...rows].join('\n')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    },
    []
  )

  return { exportCsv }
}
