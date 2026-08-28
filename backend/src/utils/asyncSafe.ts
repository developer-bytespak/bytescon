// =============================================================
// asyncSafe — fire-and-forget background tasks with guaranteed audit
//
// Why this exists: silent promise rejections in inline `(async () => { ... })()`
// blocks erase notification + side-effect failures from compliance reporting.
// Loggers fire, but the AuditEvent table — which is what compliance + billing
// triage actually queries — never sees the row. This helper closes that gap.
//
// Behavior:
//   - Runs the supplied async fn off the request path
//   - On rejection: writes a structured Winston error AND a single AuditEvent
//     row (action: BACKGROUND_TASK_FAILED) tagged with the call-site label
//   - Never throws, never blocks, never bubbles into the caller
//
// Audit-row writes are themselves fire-and-forget and cannot crash the helper.
// =============================================================
import { logger } from './logger'
import { logAudit, type AuditAction } from '../services/auditService'

export interface RunBackgroundOptions {
  /**
   * Tenant scope for the failure-audit row. If absent, no audit row is
   * written — only the Winston error. Provide whenever the firm context
   * is known so the failure is queryable per-firm.
   */
  consultingFirmId?: string | null
  /**
   * Free-form entity label written to AuditEvent.entityType. Defaults to
   * 'BackgroundTask'. Use a domain label like 'Notification' or
   * 'DocumentRequirement' so post-hoc queries can filter cleanly.
   */
  entityType?: string
  /**
   * Optional id of the underlying entity the task is about (e.g. the
   * deliverable id whose notification failed).
   */
  entityId?: string | null
  /**
   * Override the audit action when a more specific value applies
   * (e.g. 'EMAIL_DELIVERY_FAILED' for a mailer rejection).
   */
  failureAction?: AuditAction
}

export function runBackground(
  label: string,
  fn: () => Promise<void>,
  opts: RunBackgroundOptions = {},
): void {
  void Promise.resolve()
    .then(fn)
    .catch((err: unknown) => {
      const errorMessage = err instanceof Error ? err.message : String(err)
      logger.error(`background-task failed: ${label}`, {
        label,
        error: errorMessage,
        stack: err instanceof Error ? err.stack : undefined,
        consultingFirmId: opts.consultingFirmId ?? null,
        entityId: opts.entityId ?? null,
      })

      if (opts.consultingFirmId) {
        // logAudit catches its own errors and never throws.
        void logAudit({
          consultingFirmId: opts.consultingFirmId,
          actorUserId: null,
          actorRole: 'system',
          action: opts.failureAction ?? 'BACKGROUND_TASK_FAILED',
          entityType: opts.entityType ?? 'BackgroundTask',
          entityId: opts.entityId ?? null,
          rationale: `${label}: ${errorMessage}`,
        })
      }
    })
}
