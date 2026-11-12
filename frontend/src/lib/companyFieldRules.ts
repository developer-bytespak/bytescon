// Checks for company profile fields, shown next to each field as you type.
// They mirror the server's rules (backend routes/profile.ts and
// routes/registration.ts), so a form that passes here is accepted there.
// Each returns an error message, or null when the value is fine. A blank
// optional field is fine; required fields are checked by `required`.

export const required = (label: string) => (v: string): string | null =>
  v.trim() ? null : `${label} is required`

const lengthNote = (v: string) => ` (you have ${v.length})`

export function companyName(v: string): string | null {
  const t = v.trim()
  if (!t) return 'Company name is required'
  if (t.length < 2) return 'Company name must be at least 2 characters'
  if (t.length > 120) return 'Company name must be 120 characters or fewer'
  return null
}

export function uei(v: string): string | null {
  const t = v.trim()
  if (!t) return null
  if (!/^[A-Za-z0-9]+$/.test(t)) return 'UEI can only contain letters and digits'
  return t.length === 12 ? null : `UEI must be exactly 12 characters${lengthNote(t)}`
}

export function cage(v: string): string | null {
  const t = v.trim()
  if (!t) return null
  if (!/^[A-Za-z0-9]+$/.test(t)) return 'CAGE code can only contain letters and digits'
  return t.length === 5 ? null : `CAGE code must be exactly 5 characters${lengthNote(t)}`
}

const splitList = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean)

export function naicsList(v: string): string | null {
  const bad = splitList(v).filter((c) => !/^\d{2,6}$/.test(c))
  return bad.length ? `NAICS codes are 2 to 6 digits — check ${bad.join(', ')}` : null
}

export function pscList(v: string): string | null {
  const bad = splitList(v).filter((c) => !/^[A-Za-z0-9]{4}$/.test(c))
  return bad.length ? `PSC codes are 4 letters or digits — check ${bad.join(', ')}` : null
}

export function zip(v: string): string | null {
  const t = v.trim()
  return !t || /^\d{5}(-\d{4})?$/.test(t) ? null : 'ZIP code must be 5 digits, or 5+4 (12345-6789)'
}

export function phone(v: string): string | null {
  const t = v.trim()
  if (!t) return null
  if (!/^[\d\s()+.-]+$/.test(t)) return 'Phone can only contain digits, spaces and ( ) + - .'
  const digits = t.replace(/\D/g, '').length
  return digits >= 10 && digits <= 15 ? null : `Phone must have 10 to 15 digits (you have ${digits})`
}

export function website(v: string): string | null {
  const t = v.trim()
  return !t || /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(t) ? null : 'Website must be a web address, e.g. example.com'
}

/** A whole number of 0 or more; commas allowed. */
export function wholeNumber(label: string) {
  return (v: string): string | null => {
    const t = v.replace(/[,\s]/g, '')
    return !t || /^\d+$/.test(t) ? null : `${label} must be a whole number`
  }
}

/** An amount in dollars of 0 or more; "$" and commas allowed. */
export function dollars(label: string) {
  return (v: string): string | null => {
    const t = v.replace(/[$,\s]/g, '')
    return !t || /^\d+(\.\d{1,2})?$/.test(t) ? null : `${label} must be an amount in dollars, e.g. 4500000`
  }
}

/** Runs each field's rule; returns only the fields with an error. */
export function checkAll<K extends string>(values: Record<K, string>, rules: Partial<Record<K, (v: string) => string | null>>): Partial<Record<K, string>> {
  const errors: Partial<Record<K, string>> = {}
  for (const key of Object.keys(rules) as K[]) {
    const message = rules[key]?.(values[key] ?? '')
    if (message) errors[key] = message
  }
  return errors
}
