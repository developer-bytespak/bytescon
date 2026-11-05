import { api } from '../services/api'

export interface DemoStatus {
  expiresAt: string | null
  isOperator: boolean
}

export interface DemoAccount {
  firmId: string
  companyName: string
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

export const demoApi = {
  status: () => api.get<{ data: DemoStatus }>('/demo/status').then((r) => r.data.data),
  list: () => api.get<{ data: { accounts: DemoAccount[]; defaultDays: number; states: Array<{ code: string; name: string }> } }>('/demo/accounts').then((r) => r.data.data),
  create: (input: { companyName: string; contactName: string; email: string; days: number; state: string; otherLocation?: string }) =>
    api.post<{ data: DemoCredentials & { expiresAt: string; firmId: string } }>('/demo/accounts', input).then((r) => r.data.data),
  extend: (firmId: string, days: number) => api.post(`/demo/accounts/${firmId}/extend`, { days }),
  end: (firmId: string) => api.post(`/demo/accounts/${firmId}/end`),
  resetPassword: (firmId: string) =>
    api.post<{ data: DemoCredentials }>(`/demo/accounts/${firmId}/reset-password`).then((r) => r.data.data),
}
