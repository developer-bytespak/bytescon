// US states, DC and territories, for address "State" dropdowns. The value
// saved is the two-letter postal code, as SAM.gov records it.
export const US_STATES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'AL', name: 'Alabama' }, { code: 'AK', name: 'Alaska' }, { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' }, { code: 'CA', name: 'California' }, { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' }, { code: 'DE', name: 'Delaware' }, { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' }, { code: 'GA', name: 'Georgia' }, { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' }, { code: 'IL', name: 'Illinois' }, { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' }, { code: 'KS', name: 'Kansas' }, { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' }, { code: 'ME', name: 'Maine' }, { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' }, { code: 'MI', name: 'Michigan' }, { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' }, { code: 'MO', name: 'Missouri' }, { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' }, { code: 'NV', name: 'Nevada' }, { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' }, { code: 'NM', name: 'New Mexico' }, { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' }, { code: 'ND', name: 'North Dakota' }, { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' }, { code: 'OR', name: 'Oregon' }, { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' }, { code: 'SC', name: 'South Carolina' }, { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' }, { code: 'TX', name: 'Texas' }, { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' }, { code: 'VA', name: 'Virginia' }, { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' }, { code: 'WI', name: 'Wisconsin' }, { code: 'WY', name: 'Wyoming' },
  { code: 'AS', name: 'American Samoa' }, { code: 'GU', name: 'Guam' }, { code: 'MP', name: 'Northern Mariana Islands' },
  { code: 'PR', name: 'Puerto Rico' }, { code: 'VI', name: 'U.S. Virgin Islands' },
]

/**
 * The dropdown choices for a saved value. A value saved before the dropdown
 * existed (e.g. "Texas" or "tx") is matched to its code; one that matches
 * nothing is kept as an extra choice so opening the form never loses it.
 */
export function stateOptions(current: string | null | undefined): Array<{ value: string; label: string }> {
  const options = US_STATES.map((s) => ({ value: s.code, label: `${s.name} (${s.code})` }))
  const saved = (current ?? '').trim()
  if (saved && !toStateCode(saved)) options.unshift({ value: saved, label: saved })
  return options
}

/** The postal code for a code or a full name, ignoring case; null if neither. */
export function toStateCode(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().toLowerCase()
  if (!v) return null
  const hit = US_STATES.find((s) => s.code.toLowerCase() === v || s.name.toLowerCase() === v)
  return hit ? hit.code : null
}
