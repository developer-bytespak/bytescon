// =============================================================
// Beta Reset Script — fresh 15-slot beta state with optional
// single-user preservation.
//
// DESTRUCTIVE. Truncates tenant data so the platform comes up
// empty (or empty-except-for-the-kept-user) with the 15 beta
// slots free.
//
// Preserves (always):
//   - FAR / DFARS / NIST / CMMC / Section 508 regulatory ontology
//   - NaicsCode lookup table
//   - SubscriptionPlan rows
//   - TermsOfServiceVersion + BetaNdaVersion (current legal docs)
//   - BetaWeeklyQuestionnaire definitions
//
// Preserves (when KEEP_USER_EMAIL is set):
//   - The user with that email, their ConsultingFirm, and ALL
//     data scoped to that firm (clients, opportunities, decisions,
//     submissions, audits, agreements, etc.)
//   - Auto-marks that user isEmailVerified=true
//   - Auto-accepts the current ToS on their behalf so
//     they don't hit gate-2 on next login
//
// SAFETY GATES (must pass all three):
//   1. NODE_ENV must NOT be 'production' UNLESS RESET_BETA_PROD_OK=I_HAVE_A_BACKUP
//   2. RESET_BETA_CONFIRM must equal 'YES_DELETE_ALL_DATA'
//   3. Interactive prompt — operator types "RESET" to proceed
//      (skipped only if RESET_BETA_NONINTERACTIVE=1)
//
// Run examples:
//   # Wipe everything, no preservation
//   RESET_BETA_CONFIRM=YES_DELETE_ALL_DATA \
//     npx ts-node backend/prisma/scripts/resetBeta.ts
//
//   # Wipe everything except johngladmon11@gmail.com's firm
//   KEEP_USER_EMAIL=johngladmon11@gmail.com \
//     RESET_BETA_CONFIRM=YES_DELETE_ALL_DATA \
//     RESET_BETA_PROD_OK=I_HAVE_A_BACKUP \
//     RESET_BETA_NONINTERACTIVE=1 \
//     npx ts-node backend/prisma/scripts/resetBeta.ts
// =============================================================
import { PrismaClient } from '@prisma/client'
import * as readline from 'readline'

const prisma = new PrismaClient()

async function confirmInteractive(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ans = await new Promise<string>((resolve) =>
    rl.question('Type "RESET" to proceed (anything else aborts): ', (a) => {
      rl.close()
      resolve(a)
    })
  )
  return ans.trim() === 'RESET'
}

async function main() {
  // Gate 1 — production safety
  if (process.env.NODE_ENV === 'production' && process.env.RESET_BETA_PROD_OK !== 'I_HAVE_A_BACKUP') {
    console.error('REFUSED: NODE_ENV=production and RESET_BETA_PROD_OK is not set to "I_HAVE_A_BACKUP".')
    console.error('Take a database backup first, then re-run with RESET_BETA_PROD_OK=I_HAVE_A_BACKUP.')
    process.exit(1)
  }

  // Gate 2 — explicit confirmation env var
  if (process.env.RESET_BETA_CONFIRM !== 'YES_DELETE_ALL_DATA') {
    console.error('REFUSED: RESET_BETA_CONFIRM env must equal "YES_DELETE_ALL_DATA".')
    console.error('Re-run with: RESET_BETA_CONFIRM=YES_DELETE_ALL_DATA npx ts-node backend/prisma/scripts/resetBeta.ts')
    process.exit(1)
  }

  const keepEmail = (process.env.KEEP_USER_EMAIL || '').trim().toLowerCase() || null

  // Resolve the keep target up front. If the email is set but the user
  // doesn't exist, abort — better to fail loud than silently wipe.
  let keepFirmId: string | null = null
  let keepUserId: string | null = null
  if (keepEmail) {
    const keepUser = await prisma.user.findFirst({
      where: { email: { equals: keepEmail, mode: 'insensitive' } },
      select: { id: true, email: true, consultingFirmId: true, firstName: true, lastName: true },
    })
    if (!keepUser) {
      console.error(`REFUSED: KEEP_USER_EMAIL="${keepEmail}" was set but no user with that email exists.`)
      console.error('Either remove KEEP_USER_EMAIL to wipe everything, or fix the email.')
      process.exit(1)
    }
    keepUserId = keepUser.id
    keepFirmId = keepUser.consultingFirmId
    console.log(`Preserving: ${keepUser.firstName} ${keepUser.lastName} <${keepUser.email}>`)
    console.log(`  userId=${keepUserId}  firmId=${keepFirmId}`)
  } else {
    console.log('No KEEP_USER_EMAIL set — full wipe of all tenant data.')
  }

  // Gate 3 — interactive Enter (skipped only if RESET_BETA_NONINTERACTIVE=1)
  if (process.env.RESET_BETA_NONINTERACTIVE !== '1') {
    console.log('================================================================')
    console.log(' BETA RESET — DESTRUCTIVE')
    if (keepFirmId) {
      console.log(` All tenant data EXCEPT firm ${keepFirmId} will be deleted.`)
    } else {
      console.log(' This will TRUNCATE all tenant data: firms, users, opportunities,')
      console.log(' decisions, submissions, audit events, agreements.')
    }
    console.log(' Catalog tables (FAR/DFARS/NIST/CMMC/508/NAICS) will be preserved.')
    console.log('================================================================')
    const ok = await confirmInteractive()
    if (!ok) {
      console.log('Aborted.')
      process.exit(0)
    }
  }

  console.log('\nResetting...')

  // -------------------------------------------------------------
  // PATH A: full wipe (no KEEP_USER_EMAIL set)
  // -------------------------------------------------------------
  if (!keepFirmId) {
    const fullWipeTables = [
      // Audit + agreements + verification
      'audit_events',
      'user_agreements',
      'email_verification_tokens',
      'password_reset_tokens',
      'beta_questionnaire_responses',
      // Compliance + proposal artifacts
      'far_clause_applicabilities',
      'compliance_logs',
      'matrix_requirements',
      'compliance_matrices',
      'adherence_scores',
      'review_comments',
      'review_cycles',
      'section_evidence_links',
      'evidence_artifacts',
      'proposal_sections',
      'past_performance_records',
      'cost_volumes',
      // Bid decisions + capture + market
      'bid_decision_history',
      'bid_decisions',
      'capture_tasks',
      'capture_plans',
      'teaming_arrangements',
      'partners',
      'competitors',
      'cmmc_statuses',
      // Opportunity-scoped
      'amendments',
      'award_history',
      'opportunity_documents',
      // Document templates / rewards / portal
      'document_requirements',
      'document_templates',
      'shared_templates',
      'client_documents',
      'compliance_rewards',
      'client_portal_uploads',
      'client_portal_users',
      'client_opportunity_declines',
      'performance_stats',
      'client_naics',
      // Submissions + financials
      'financial_penalties',
      'submission_records',
      // Workflow + ingestion + analytics + state municipal
      'state_municipal_opportunities',
      'subcontract_opportunities',
      'ingestion_jobs',
      'api_usage_logs',
      'market_watchlist_entries',
      // Billing
      'invoice_line_items',
      'invoices',
      'subscriptions',
      // Backtest
      'backtest_predictions',
      'backtest_runs',
      // Opportunities + clients + users + firms (last because most depended-upon)
      'opportunities',
      'client_companies',
      'users',
      'consulting_firms',
    ]

    for (const table of fullWipeTables) {
      try {
        await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE;`)
        console.log(`  truncated ${table}`)
      } catch (err) {
        console.log(`  skipped  ${table} (${(err as Error).message.split('\n')[0]})`)
      }
    }
  } else {
    // -------------------------------------------------------------
    // PATH B: selective wipe — preserve everything tied to keepFirmId
    // -------------------------------------------------------------
    // Strategy: for every tenant-scoped table, DELETE rows where
    // consultingFirmId != keepFirmId. Tables without a tenant column
    // get joined through their parent. Order respects FK constraints
    // (children before parents).
    const stmts: { label: string; sql: string }[] = [
      // Audit + agreements + verification (firm-scoped via user)
      {
        label: 'audit_events (other firms)',
        sql: `DELETE FROM audit_events WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'user_agreements (users not in keep firm)',
        sql: `DELETE FROM user_agreements WHERE "userId" IN (SELECT id FROM users WHERE "consultingFirmId" <> $1)`,
      },
      {
        label: 'email_verification_tokens (other firms)',
        sql: `DELETE FROM email_verification_tokens WHERE "userId" IN (SELECT id FROM users WHERE "consultingFirmId" <> $1)`,
      },
      {
        label: 'password_reset_tokens (other firms)',
        sql: `DELETE FROM password_reset_tokens WHERE "userId" IN (SELECT id FROM users WHERE "consultingFirmId" <> $1)`,
      },
      {
        label: 'beta_questionnaire_responses (other firms)',
        sql: `DELETE FROM beta_questionnaire_responses WHERE "consultingFirmId" <> $1`,
      },

      // Compliance + proposal artifacts
      {
        label: 'far_clause_applicabilities (other firms)',
        sql: `DELETE FROM far_clause_applicabilities WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'compliance_logs (other firms)',
        sql: `DELETE FROM compliance_logs WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'matrix_requirements (via matrix→other firms)',
        sql: `DELETE FROM matrix_requirements WHERE "matrixId" IN (SELECT id FROM compliance_matrices WHERE "consultingFirmId" <> $1)`,
      },
      {
        label: 'compliance_matrices (other firms)',
        sql: `DELETE FROM compliance_matrices WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'adherence_scores (other firms)',
        sql: `DELETE FROM adherence_scores WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'review_comments (via cycle→other firms)',
        sql: `DELETE FROM review_comments WHERE "reviewCycleId" IN (SELECT id FROM review_cycles WHERE "consultingFirmId" <> $1)`,
      },
      {
        label: 'review_cycles (other firms)',
        sql: `DELETE FROM review_cycles WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'section_evidence_links (via section→other firms)',
        sql: `DELETE FROM section_evidence_links WHERE "proposalSectionId" IN (SELECT id FROM proposal_sections WHERE "consultingFirmId" <> $1)`,
      },
      {
        label: 'evidence_artifacts (other firms)',
        sql: `DELETE FROM evidence_artifacts WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'proposal_sections (other firms)',
        sql: `DELETE FROM proposal_sections WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'past_performance_records (other firms)',
        sql: `DELETE FROM past_performance_records WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'cost_volumes (other firms)',
        sql: `DELETE FROM cost_volumes WHERE "consultingFirmId" <> $1`,
      },

      // Bid decisions + capture + market
      {
        label: 'bid_decision_history (other firms)',
        sql: `DELETE FROM bid_decision_history WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'bid_decisions (other firms)',
        sql: `DELETE FROM bid_decisions WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'capture_tasks (via plan→other firms)',
        sql: `DELETE FROM capture_tasks WHERE "capturePlanId" IN (SELECT id FROM capture_plans WHERE "consultingFirmId" <> $1)`,
      },
      {
        label: 'capture_plans (other firms)',
        sql: `DELETE FROM capture_plans WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'teaming_arrangements (other firms)',
        sql: `DELETE FROM teaming_arrangements WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'partners (other firms)',
        sql: `DELETE FROM partners WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'competitors (other firms)',
        sql: `DELETE FROM competitors WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'cmmc_statuses (other firms)',
        sql: `DELETE FROM cmmc_statuses WHERE "consultingFirmId" <> $1`,
      },

      // Opportunity-scoped (via opportunity)
      {
        label: 'amendments (via opp→other firms)',
        sql: `DELETE FROM amendments WHERE "opportunityId" IN (SELECT id FROM opportunities WHERE "consultingFirmId" <> $1)`,
      },
      {
        label: 'award_history (via opp→other firms)',
        sql: `DELETE FROM award_history WHERE "opportunityId" IN (SELECT id FROM opportunities WHERE "consultingFirmId" <> $1)`,
      },
      {
        label: 'opportunity_documents (via opp→other firms)',
        sql: `DELETE FROM opportunity_documents WHERE "opportunityId" IN (SELECT id FROM opportunities WHERE "consultingFirmId" <> $1)`,
      },

      // Document templates / rewards / portal
      {
        label: 'document_requirements (other firms)',
        sql: `DELETE FROM document_requirements WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'document_templates (other firms)',
        sql: `DELETE FROM document_templates WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'shared_templates (other firms)',
        sql: `DELETE FROM shared_templates WHERE "submittedByFirmId" <> $1`,
      },
      {
        label: 'client_documents (other firms)',
        sql: `DELETE FROM client_documents WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'compliance_rewards (via client→other firms)',
        sql: `DELETE FROM compliance_rewards WHERE "clientCompanyId" IN (SELECT id FROM client_companies WHERE "consultingFirmId" <> $1)`,
      },
      {
        label: 'client_portal_uploads (other firms)',
        sql: `DELETE FROM client_portal_uploads WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'client_portal_users (via client→other firms)',
        sql: `DELETE FROM client_portal_users WHERE "clientCompanyId" IN (SELECT id FROM client_companies WHERE "consultingFirmId" <> $1)`,
      },
      {
        label: 'client_opportunity_declines (via client→other firms)',
        sql: `DELETE FROM client_opportunity_declines WHERE "clientCompanyId" IN (SELECT id FROM client_companies WHERE "consultingFirmId" <> $1)`,
      },
      {
        label: 'performance_stats (via client→other firms)',
        sql: `DELETE FROM performance_stats WHERE "clientCompanyId" IN (SELECT id FROM client_companies WHERE "consultingFirmId" <> $1)`,
      },
      {
        label: 'client_naics (via client→other firms)',
        sql: `DELETE FROM client_naics WHERE "clientCompanyId" IN (SELECT id FROM client_companies WHERE "consultingFirmId" <> $1)`,
      },

      // Submissions + financials
      {
        label: 'financial_penalties (other firms)',
        sql: `DELETE FROM financial_penalties WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'submission_records (other firms)',
        sql: `DELETE FROM submission_records WHERE "consultingFirmId" <> $1`,
      },

      // Workflow + ingestion + analytics + state municipal
      {
        label: 'state_municipal_opportunities (other firms)',
        sql: `DELETE FROM state_municipal_opportunities WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'subcontract_opportunities (other firms)',
        sql: `DELETE FROM subcontract_opportunities WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'ingestion_jobs (other firms)',
        sql: `DELETE FROM ingestion_jobs WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'api_usage_logs (other firms)',
        sql: `DELETE FROM api_usage_logs WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'market_watchlist_entries (other firms)',
        sql: `DELETE FROM market_watchlist_entries WHERE "consultingFirmId" <> $1`,
      },

      // Billing
      {
        label: 'invoice_line_items (via invoice→other firms)',
        sql: `DELETE FROM invoice_line_items WHERE "invoiceId" IN (SELECT id FROM invoices WHERE "consultingFirmId" <> $1)`,
      },
      {
        label: 'invoices (other firms)',
        sql: `DELETE FROM invoices WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'subscriptions (other firms)',
        sql: `DELETE FROM subscriptions WHERE "consultingFirmId" <> $1`,
      },

      // Backtest (admin-only, but tagged with consultingFirmId for audit)
      {
        label: 'backtest_predictions (via run→other firms)',
        sql: `DELETE FROM backtest_predictions WHERE "runId" IN (SELECT id FROM backtest_runs WHERE "consultingFirmId" <> $1)`,
      },
      {
        label: 'backtest_runs (other firms)',
        sql: `DELETE FROM backtest_runs WHERE "consultingFirmId" <> $1`,
      },

      // Top-level: opportunities → client_companies → users → consulting_firms
      {
        label: 'opportunities (other firms)',
        sql: `DELETE FROM opportunities WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'client_companies (other firms)',
        sql: `DELETE FROM client_companies WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'users (other firms)',
        sql: `DELETE FROM users WHERE "consultingFirmId" <> $1`,
      },
      {
        label: 'consulting_firms (other firms)',
        sql: `DELETE FROM consulting_firms WHERE "id" <> $1`,
      },
    ]

    for (const s of stmts) {
      try {
        const count = await prisma.$executeRawUnsafe(s.sql, keepFirmId)
        console.log(`  ${s.label}: ${count} rows deleted`)
      } catch (err) {
        console.log(`  ${s.label}: skipped (${(err as Error).message.split('\n')[0]})`)
      }
    }

    // Auto-bless the kept user so they don't hit gate-1/gate-2 on next login.
    if (keepUserId) {
      await prisma.user.update({
        where: { id: keepUserId },
        data: {
          isEmailVerified: true,
          emailVerifiedAt: new Date(),
        },
      })
      console.log(`  marked ${keepEmail} as email-verified`)

      const tos = await prisma.termsOfServiceVersion.findFirst({ where: { isCurrent: true } })
      if (tos) {
        await prisma.userAgreement.createMany({
          data: [
            {
              userId: keepUserId,
              documentType: 'TOS',
              documentId: tos.id,
              version: tos.version,
              contentHash: tos.contentHash,
              ip: '0.0.0.0::reset-keep',
              userAgent: 'reset-script',
            },
          ],
          skipDuplicates: true,
        })
        console.log(`  auto-accepted ToS v${tos.version} for ${keepEmail}`)
      } else {
        console.log('  WARN: ToS not seeded — kept user will hit gate-2 on next login')
      }
    }
  }

  // Verify final state
  const firmCount = await prisma.consultingFirm.count()
  const userCount = await prisma.user.count()
  console.log(`\nFinal state: ${firmCount} firm(s), ${userCount} user(s).`)
  const maxSlots = parseInt(process.env.MAX_BETA_SLOTS || '15', 10)
  console.log(`Beta slots: ${Math.max(0, maxSlots - firmCount)}/${maxSlots} available.`)
  console.log('Reset complete.')
}

main()
  .catch((err) => {
    console.error('Reset FAILED:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
