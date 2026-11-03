# Fix: silent background jobs, and a false daily backup alert

**Bugs:** B13 and B23 in [14-review-bugs-improvements-competitors.md](14-review-bugs-improvements-competitors.md)
**Opened:** 2026-11-04 · **Status:** ✅ **Done** (2026-11-04)

---

## 1. Findings

**Simple version:** Bytescon runs jobs in the background, such as fetching new leads every hour, sending
saved-search alerts every 15 minutes and sending milestone reminders. Most jobs warn the team when they fail or
stop. Two groups of jobs didn't. If lead sync or reminders broke, nobody would find out until a customer
complained.

The opposite problem also existed. A check for a "nightly backup" script raised an alarm every day, but that
script no longer exists: the database is backed up by Neon. Daily false alarms teach people to ignore real ones.

**Technical version:**

| # | Finding | Evidence | Effect |
|---|---------|----------|--------|
| B13-a | Section 6 worker not monitored | `server.ts` calls `wireJobObservability` for every worker except `section6Worker`. It runs `source-sync` (hourly), `profile-alerts` (15 min), `milestone-reminders` (hourly) and `discovery-intel` (6 h) | Failures only reached the log; no alert, no staleness watch |
| B13-b | GB-107 not monitored | `mountGb107()`'s worker (`gb107-poll` every minute, `gb107-backfill` every 6 h) was never wired | Same |
| B13-c | One worker, one heartbeat | `wireJobObservability` recorded one heartbeat per worker. For a worker with four jobs, one job could stop while the others kept the heartbeat fresh | A stopped job could hide |
| B23 | False backup alert | `EXPECTED_JOBS` in `services/jobHealth.ts` watched `nightly-backup` unconditionally. No host backup script exists any more (production uses Neon's backups) | A "Scheduled job has NEVER succeeded: nightly-backup" alert every day |

## 2. Change

| Area | Change |
|------|--------|
| Per-job heartbeats | `wireJobObservability` takes an optional `nameOf(job)`, so each scheduled job in a worker has its own heartbeat and its own failure alert |
| Section 6 | Wired with one heartbeat per job name. Failures alert as **critical** |
| GB-107 | Wired as `gb107-poll` / `gb107-backfill`. Failures alert as a **warning** (enrichment is a nice-to-have) |
| Staleness watch | Added to `EXPECTED_JOBS`: `source-sync` 3 h, `profile-alerts` 2 h, `milestone-reminders` 3 h, `discovery-intel` 14 h, `gb107-poll` 2 h, `gb107-backfill` 14 h. The watchdog sweeps hourly, so these windows leave room for a redeploy |
| Backup alert | `nightly-backup` is only watched when `NIGHTLY_BACKUP_HEARTBEAT_ENABLED=true`, i.e. when a backup script actually reports in. It's documented in `backend/.env.example` |

## 3. Verification results (2026-11-04)

| Check | Result |
|-------|--------|
| New tests `backend/src/services/jobHealth.integration.test.ts` | ✅ 9/9: separate heartbeats per job; a failed job alerts by name; GB-107 alerts as a warning; a silent job alerts and a fresh one doesn't; all six jobs are watched; the backup check is off unless enabled |
| Tests catch regressions | ✅ With per-job names ignored, 3 failed. With one Section 6 job dropped from the watch list, 1 failed. With the backup check always on, 1 failed. Code restored |
| Full backend suite | ✅ 4,411/4,411 |
| Type-check | ✅ clean. No frontend change |

**Live check in the running app** (local, 22:06–22:15 UTC):

| Step | Result |
|------|--------|
| `gb107-poll` and `profile-alerts` ran | ✅ Each recorded its own heartbeat. `source-sync` did too, at 22:05 |
| Hourly watchdog sweep (22:15) | ✅ Registered all six new jobs (one window to report before alerting); **no** nightly-backup alert |

### How to check it in production
After deploy, `GET /api/ops/status` (with the `X-Ops-Token` header) lists `source-sync`, `profile-alerts`,
`milestone-reminders`, `discovery-intel`, `gb107-poll` and `gb107-backfill` with recent success times. This needs
`OPS_HEARTBEAT_TOKEN` (owner task T7). Alerts need `PLATFORM_ADMIN_EMAIL` or `ALERT_WEBHOOK_URL` (also T7).

### Known, not changed
- **Free hosting sleeps (B2):** while the free Render server is asleep, no job runs, so the watchdog can't run
  either. Upgrading Render (T3) fixes this.
- **Per-source failures:** the source sync job keeps going when one source fails, and records it on that source.
  Only a failure of the whole job alerts.
