// =============================================================
// §7.0 — Internal runtime diagnostic handler.
//
// This exists so the shared runtime can be proven end-to-end WITHOUT
// implementing one of the nine domain agents prematurely. It touches no
// business table and is filtered out of every product-facing API response.
//
// The mode is carried on the run's trigger entity so a single handler can
// exercise success, failure, timeout, escalation, artifact persistence and the
// budget guard:
//
//   triggerEntityType = 'DIAGNOSTIC_MODE'
//   triggerEntityId   = 'succeed' | 'fail' | 'timeout' | 'escalate'
//                     | 'budget'  | 'review' | 'skip'
// =============================================================
import type { AgentExecutionContext, AgentHandlerResult } from '../types'

export const DIAGNOSTIC_MODE_ENTITY_TYPE = 'DIAGNOSTIC_MODE'

export type DiagnosticMode = 'succeed' | 'fail' | 'timeout' | 'escalate' | 'budget' | 'review' | 'skip'

function modeOf(ctx: AgentExecutionContext): DiagnosticMode {
  if (ctx.triggerEntityType !== DIAGNOSTIC_MODE_ENTITY_TYPE) return 'succeed'
  const raw = (ctx.triggerEntityId ?? 'succeed') as DiagnosticMode
  return raw
}

/** Sleeps in short slices so cancellation and timeout are observable. */
async function interruptibleSleep(ctx: AgentExecutionContext, totalMs: number): Promise<void> {
  const step = 100
  let elapsed = 0
  while (elapsed < totalMs) {
    if (ctx.signal.aborted) return
    await new Promise((r) => setTimeout(r, step))
    elapsed += step
  }
}

export async function internalDiagnosticHandler(ctx: AgentExecutionContext): Promise<AgentHandlerResult> {
  const mode = modeOf(ctx)
  ctx.log('diagnostic handler start', { mode })

  await ctx.heartbeat(25, `diagnostic:${mode}`)

  const evidence = [
    {
      sourceType: 'RUNTIME_SELF_CHECK',
      sourceId: ctx.runId,
      sourceLocator: `agent-runtime/${ctx.agentKey}`,
      retrievedAt: new Date().toISOString(),
      note: 'Synthetic evidence produced by the runtime diagnostic; not business data.',
    },
  ]

  if (mode === 'fail') {
    throw new Error('diagnostic: intentional handler failure')
  }

  if (mode === 'timeout') {
    // Deliberately outruns the diagnostic agent's maxRuntimeMs.
    await interruptibleSleep(ctx, 60_000)
    return {
      status: 'COMPLETED',
      summary: 'diagnostic: should have been timed out before reaching here',
      confidence: 'LOW',
      dataSufficiency: 'PARTIAL',
    }
  }

  if (mode === 'budget') {
    // Proves the guard refuses BEFORE any provider call. The guard throws
    // AgentBudgetExhaustedError, which the dispatcher records structurally.
    await ctx.budget.generate(
      { systemPrompt: 'diagnostic', userPrompt: 'diagnostic', maxTokens: 16 },
      { task: 'AI_ASSISTANT', estimatedTokens: 1_000_000 },
    )
    return {
      status: 'COMPLETED',
      summary: 'diagnostic: budget guard did not block (unexpected)',
      confidence: 'LOW',
      dataSufficiency: 'PARTIAL',
    }
  }

  if (mode === 'skip') {
    return {
      status: 'SKIPPED',
      summary: 'diagnostic: nothing to do',
      confidence: 'INSUFFICIENT_DATA',
      dataSufficiency: 'INSUFFICIENT',
      limitations: ['Diagnostic skip mode performs no work by design.'],
    }
  }

  await ctx.heartbeat(70, 'diagnostic:building-artifact')

  const result: AgentHandlerResult = {
    status: mode === 'review' ? 'WAITING_FOR_REVIEW' : 'COMPLETED',
    summary: `Runtime diagnostic completed in ${mode} mode.`,
    confidence: 'HIGH',
    dataSufficiency: 'SUFFICIENT',
    evidence,
    artifacts: [
      {
        artifactType: 'RUNTIME_DIAGNOSTIC',
        title: `Runtime diagnostic — ${mode}`,
        summary: 'Structured output proving artifact persistence works.',
        structuredData: {
          mode,
          runId: ctx.runId,
          attempt: ctx.attempt,
          autonomyLevel: ctx.autonomyLevel,
          canApplyNoop: ctx.canApply('diagnostic.noop'),
          canApplyUnlisted: ctx.canApply('diagnostic.not-allowlisted'),
        },
        evidence,
        sourceEntityType: DIAGNOSTIC_MODE_ENTITY_TYPE,
        sourceEntityId: mode,
        confidenceState: 'HIGH',
        // Stable per (agent, mode) so a re-run supersedes rather than piles up.
        supersedeKey: `diagnostic:${mode}`,
      },
    ],
    proposedActions: [
      { actionKey: 'diagnostic.noop', description: 'No-op action used to exercise the autonomy policy.' },
    ],
    metrics: { heartbeats: 2, artifactsBuilt: 1 },
    inputSnapshot: { mode, attempt: ctx.attempt },
    inputHash: `diagnostic:${mode}`,
  }

  if (mode === 'escalate') {
    result.escalations = [
      {
        severity: 'HIGH',
        title: 'Runtime diagnostic escalation',
        reason: 'Diagnostic escalate mode always raises one escalation so dedupe can be proven.',
        recommendedAction: 'Acknowledge and resolve; this is a synthetic item.',
        entityType: DIAGNOSTIC_MODE_ENTITY_TYPE,
        entityId: mode,
        dedupeHint: `diagnostic-escalate:${mode}`,
      },
    ]
  }

  return result
}
