// Round a number to a fixed number of decimal places, returning a number
// (not a string). Used to keep persisted probability scores from carrying
// 16-digit float noise over the wire. Calculations stay full-precision —
// only the stored/serialized boundary is rounded.
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
