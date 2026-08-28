// =============================================================
// §7.0 — API client for the shared agent runtime.
//
// Uses the shared `api` axios instance so auth, 401 handling and paywall events
// behave exactly as everywhere else. Types mirror the backend responses; the
// backend stays the single source of truth for every status and count.
// =============================================================
import { api } from './api'

export type AgentKey =
  | 'OPPORTUNITY' | 'QUALIFICATION' | 'COMPLIANCE' | 'PROPOSAL' | 'PRICING'
  | 'TEAMING' | 'CONTRACT_ADMINISTRATION' | 'FINANCE' | 'INTELLIGENCE'

export type AgentRunStatus =
  | 'QUEUED' | 'RUNNING' | 'WAITING_FOR_REVIEW' | 'COMPLETED'
  | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'SKIPPED'

export type AgentTriggerType = 'MANUAL' | 'SCHEDULE' | 'EVENT' | 'RETRY'
export type AgentAutonomyLevel = 'OBSERVE' | 'PROPOSE' | 'ACT_WITH_GUARDRAILS'
export type AgentConfidenceState = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_DATA'
export type AgentDataSufficiency = 'SUFFICIENT' | 'PARTIAL' | 'INSUFFICIENT'
export type AgentEscalationStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED'
export type AgentEscalationSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export type AgentScheduleType = 'CRON' | 'INTERVAL' | 'MANUAL_ONLY'

async function get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const res = await api.get(url, { params })
  return res.data.data as T
}
async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await api.post(url, body ?? {})
  return res.data.data as T
}
async function put<T>(url: string, body?: unknown): Promise<T> {
  const res = await api.put(url, body ?? {})
  return res.data.data as T
}

// -------------------------------------------------------------
// Overview + definitions
// -------------------------------------------------------------

export interface AgentOverviewRow {
  key: AgentKey
  name: string
  description: string
  implemented: boolean
  plannedSlice: string
  requiresLlm: boolean
  isEnabled: boolean
  isConfigured: boolean
  autonomyLevel: AgentAutonomyLevel
  scheduleType: AgentScheduleType | null
  cronExpression: string | null
  timezone: string
  nextRunAt: string | null
  lastRunAt: string | null
  lastSuccessfulRunAt: string | null
  lastFailureAt: string | null
  lastFailureMessage: string | null
  consecutiveFailures: number
  openEscalations: number
  lastRun: { id: string; status: AgentRunStatus; createdAt: string; finishedAt: string | null } | null
}

export interface AgentDefinition {
  key: AgentKey
  name: string
  description: string
  implemented: boolean
  plannedSlice: string
  supportedTriggers: AgentTriggerType[]
  defaultCronExpression: string | null
  defaultAutonomyLevel: AgentAutonomyLevel
  requiresLlm: boolean
  noLlmBehaviour: string
  maxRuntimeMs: number
  defaultMaxAttempts: number
  defaultTokenBudget: number | null
  supportedArtifactTypes: string[]
  subscribedEventTypes: string[]
  allowlistedActionKeys: string[]
}

// -------------------------------------------------------------
// Runs / artifacts / escalations
// -------------------------------------------------------------

export interface AgentRunSummary {
  id: string
  agentKey: AgentKey
  status: AgentRunStatus
  triggerType: AgentTriggerType
  triggerEntityType: string | null
  triggerEntityId: string | null
  attempt: number
  maxAttempts: number
  progressPercent: number
  progressStage: string | null
  outputSummary: string | null
  confidenceState: AgentConfidenceState | null
  dataSufficiency: AgentDataSufficiency | null
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  createdAt: string
  errorCode: string | null
  tokenInput: number
  tokenOutput: number
  estimatedCostUsd: string | number
}

export interface AgentArtifact {
  id: string
  runId: string
  agentKey: AgentKey
  artifactType: string
  title: string
  summary: string | null
  structuredData: Record<string, unknown>
  evidence: unknown
  sourceEntityType: string | null
  sourceEntityId: string | null
  confidenceState: AgentConfidenceState
  isHumanVerified: boolean
  verifiedByUserId: string | null
  verifiedAt: string | null
  supersededByArtifactId: string | null
  createdAt: string
}

export interface AgentEscalation {
  id: string
  runId: string | null
  agentKey: AgentKey
  severity: AgentEscalationSeverity
  status: AgentEscalationStatus
  title: string
  reason: string
  recommendedAction: string | null
  entityType: string | null
  entityId: string | null
  dueAt: string | null
  acknowledgedAt: string | null
  resolvedAt: string | null
  resolution: string | null
  createdAt: string
}

export interface AgentRunDetail extends AgentRunSummary {
  agentName: string
  autonomyLevel: AgentAutonomyLevel
  idempotencyKey: string
  initiatedByUserId: string | null
  warnings: string[]
  limitations: string[]
  errorMessage: string | null
  heartbeatAt: string | null
  inputSnapshot: Record<string, unknown> | null
  artifacts: AgentArtifact[]
  escalations: AgentEscalation[]
  schedule: { id: string; cronExpression: string | null; timezone: string; scheduleType: string } | null
  event: { id: string; eventType: string; entityType: string | null; entityId: string | null } | null
  auditEvents: Array<{ id: string; action: string; rationale: string | null; actorUserId: string | null; createdAt: string }>
}

export interface AgentSchedule {
  id: string
  agentKey: AgentKey
  isEnabled: boolean
  scheduleType: AgentScheduleType
  cronExpression: string | null
  intervalMinutes: number | null
  timezone: string
  nextRunAt: string | null
  lastRunAt: string | null
  lastSuccessfulRunAt: string | null
  lastFailureAt: string | null
  lastFailureMessage: string | null
  consecutiveFailures: number
  autonomyLevel: AgentAutonomyLevel
  maxAttempts: number
  timeoutMs: number
  tokenBudget: number | null
}

export interface AgentNotificationPreferenceRow {
  agentKey: AgentKey
  agentName: string
  isExplicit: boolean
  inAppEnabled: boolean
  emailEnabled: boolean
  minimumSeverity: AgentEscalationSeverity
  notifyOnSuccess: boolean
  notifyOnFailure: boolean
  notifyOnEscalation: boolean
  digestMode: boolean
  timezone: string
}

export interface Paged<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export const agentsApi = {
  getOverview: () => get<AgentOverviewRow[]>('/agents/overview'),
  getDefinitions: () => get<AgentDefinition[]>('/agents/definitions'),

  listRuns: (params?: Record<string, unknown>) => get<Paged<AgentRunSummary>>('/agents/runs', params),
  getRun: (id: string) => get<AgentRunDetail>(`/agents/runs/${id}`),
  triggerRun: (body: { agentKey: AgentKey; idempotencyToken?: string; triggerEntityType?: string; triggerEntityId?: string }) =>
    post<{ run: AgentRunSummary; created: boolean; note?: string }>('/agents/runs', body),
  cancelRun: (id: string) => post<{ cancelled: boolean }>(`/agents/runs/${id}/cancel`),

  listArtifacts: (params?: Record<string, unknown>) => get<Paged<AgentArtifact>>('/agents/artifacts', params),
  verifyArtifact: (id: string) => post<{ verified: boolean }>(`/agents/artifacts/${id}/verify`),

  listEscalations: (params?: Record<string, unknown>) => get<Paged<AgentEscalation>>('/agents/escalations', params),
  acknowledgeEscalation: (id: string) => post<AgentEscalation>(`/agents/escalations/${id}/acknowledge`),
  resolveEscalation: (id: string, resolution: string) => post<AgentEscalation>(`/agents/escalations/${id}/resolve`, { resolution }),
  dismissEscalation: (id: string, resolution?: string) => post<AgentEscalation>(`/agents/escalations/${id}/dismiss`, { resolution }),

  listSchedules: () => get<AgentSchedule[]>('/agents/schedules'),
  saveSchedule: (agentKey: AgentKey, patch: Partial<AgentSchedule>) =>
    put<AgentSchedule>(`/agents/schedules/${agentKey}`, patch),

  getNotificationPreferences: () => get<AgentNotificationPreferenceRow[]>('/agents/notification-preferences'),
  saveNotificationPreference: (agentKey: AgentKey, patch: Partial<AgentNotificationPreferenceRow>) =>
    put<unknown>(`/agents/notification-preferences/${agentKey}`, patch),
}
