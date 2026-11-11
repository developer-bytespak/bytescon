// Plan and product copy is written for consulting firms ("client companies",
// "Client Portal"). A contractor account bids for its own company and has
// neither, so these mentions are taken out of the text it is shown.

const CLIENT_ONLY = [
  /\s*—\s*up to \d+ client compan(?:y|ies)/gi,
  /\s*·\s*unlimited client companies/gi,
  /,\s*unlimited client companies/gi,
  /,\s*Client Portal\b/g,
  /\s*·\s*Client Portal\b/g,
]

/** A plan feature line as a contractor account should read it. */
export function contractorPlanFeature(text: string): string {
  return CLIENT_ONLY.reduce((out, pattern) => out.replace(pattern, ''), text).trim()
}
