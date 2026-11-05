import { api } from '../services/api'

export interface DemoStatus {
  expiresAt: string | null
  isOperator: boolean
}

export interface DemoAccount {
  firmId: string
  companyName: string
  businessType: string | null
  contactName: string | null
  email: string | null
  createdAt: string
  expiresAt: string
  expired: boolean
}

export interface DemoCredentials {
  email: string
  password: string
}

export interface DemoTourData {
  clients: number
  openOpportunities: number
  topOpportunity: { id: string; title: string; agency: string | null; baselineScore: number; client: string; winProbability: number; recommendation: string | null } | null
  proposal: { opportunityId: string; title: string; sections: number; verifiedRequirements: number } | null
  contract: { id: string; title: string; awardValue: number | null } | null
}

export const demoApi = {
  tour: () => api.get<{ data: DemoTourData }>('/demo/tour').then((r) => r.data.data),
  status: () => api.get<{ data: DemoStatus }>('/demo/status').then((r) => r.data.data),
  list: () => api.get<{ data: { accounts: DemoAccount[]; defaultDays: number; states: Array<{ code: string; name: string }>; businessTypes: Array<{ key: string; label: string }> } }>('/demo/accounts').then((r) => r.data.data),
  create: (input: { companyName: string; contactName: string; email: string; days: number; state: string; otherLocation?: string; businessType: string }) =>
    api.post<{ data: DemoCredentials & { expiresAt: string; firmId: string } }>('/demo/accounts', input).then((r) => r.data.data),
  extend: (firmId: string, days: number) => api.post(`/demo/accounts/${firmId}/extend`, { days }),
  end: (firmId: string) => api.post(`/demo/accounts/${firmId}/end`),
  resetPassword: (firmId: string) =>
    api.post<{ data: DemoCredentials }>(`/demo/accounts/${firmId}/reset-password`).then((r) => r.data.data),
}
