// What each staff role is called on screen. The stored role CONSULTANT is a
// read-only team member; showing it as "Consultant" clashed with consulting
// firm accounts, so the screen says what it is.
const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Admin',
  CONSULTANT: 'Read-only',
  BD_CAPTURE: 'BD / Capture',
  PROPOSAL: 'Proposal',
  CONTRACTS: 'Contracts',
  FINANCE: 'Finance',
  VIEWER: 'Viewer (auditor)',
}

export const roleLabel = (role: string | null | undefined): string =>
  role ? (ROLE_LABELS[role] ?? role) : ''
