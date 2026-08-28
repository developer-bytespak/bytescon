# GB-106, Platform and Vehicle Onboarding Module

Drop-in module for Bytescon that explains how a tenant gets onto critical
federal platforms, contract vehicles, and agencies, sequenced by prerequisite,
scored by fit, and gated by what the tenant can act on now. Built to be
integrated without modifying any existing source file.

This is the regenerated package. The original was built in a prior session,
delivered only as `govcon-gb106-onboarding.zip`, and never committed to git.
This rebuild reproduces the architecture and re-verifies all federal data
against live primary sources (see `DATA_SOURCES.md`).

## What is inside

```
govcon-gb106-onboarding/
  README.md                              this file
  DATA_SOURCES.md                        verification trail + the MAS spec conflict
  tsconfig.core.json                     strict typecheck config for the dependency-free core
  prisma/
    gb106.prisma                         additive schema fragment (2 models)
  migrations/
    2026_gb106_onboarding.sql            idempotent, prod-safe migration
  src/backend/
    types/onboarding.types.ts            type contract (dependency-free)
    data/onboarding.seed.ts              verified federal seed dataset
    logic/onboarding.logic.ts            pure scoring + gating + plan assembly
    services/onboarding.service.ts       Prisma-backed service (injected client)
    controllers/onboarding.controller.ts Express controller
    routes/onboarding.routes.ts          Express router
    jobs/onboarding.freshness.job.ts     BullMQ freshness scan
    scripts/seed.gb106.ts                standalone seed script
    mount.gb106.ts                       single-call mount helper
  src/frontend/
    hooks/useOnboarding.ts               data hook
    components/OnboardingPanel.tsx        top-level flag-gated section
    components/OnboardingProgramCard.tsx  single program card
    components/onboarding.css             baseline styles
  src/verify/
    demo.gb106.ts                        verification harness (asserts ranking + gating)
```

## Design principles

1. **Additive only.** Two new Prisma models, one new router, one mount call. No
   existing file is edited. Append `prisma/gb106.prisma` to the reconciled
   `schema.prisma`, or apply `migrations/2026_gb106_onboarding.sql` directly.
2. **Dependency-injected.** The service takes the host `PrismaClient`, the
   controller takes a tenant resolver, the job takes the host queue and worker
   factory. The module imports no host singletons and assumes no host paths.
3. **Degrades safely.** If the onboarding tables are missing or empty, read
   paths fall back to the static verified seed, so the feature is read-only
   rather than broken.
4. **Honest data.** Every program carries a verification status and source URLs.
   Unconfirmed dates are null + `NEEDS_VERIFICATION`, never invented. The
   freshness job keeps surfacing them.
5. **Sequenced.** Federal entry is dependent, not parallel. Tier 0 (SAM, UEI,
   CAGE) gates Tier 1 (SDVOSB cert) gates Tier 2 (vehicles). Gating is enforced
   in `evaluateGate`.

## Verification status (must read before relying on dates)

- VERIFIED: SAM.gov, UEI, CAGE, SBA VetCert SDVOSB, GSA MAS, OASIS+ Phase II.
- NEEDS_VERIFICATION: TMSS 2.0 (next broker registration window date) and
  Polaris SDVOSB pool (no confirmed open intake for new entrants).
- SPEC CONFLICT: the stored "$25,000 MAS Year 1" rule is the pre-2024 figure.
  Current verified rule is $100,000 over the first five-year period, then
  $125,000 per subsequent period. See `DATA_SOURCES.md`. Update the memory rule
  at your discretion.

## Integration (Windows / PowerShell, dev environment C:\Users\gladm\bytescon)

Assumes the standard repo layout and the Caddy/Nginx/Node + Postgres + Redis
docker compose stack. Adjust paths to match the live tree.

### 1. Copy the module into the repo

```powershell
# from C:\Users\gladm\bytescon
Copy-Item -Recurse .\downloads\govcon-gb106-onboarding\src\backend C:\Users\gladm\bytescon\backend\src\gb106
Copy-Item -Recurse .\downloads\govcon-gb106-onboarding\src\frontend C:\Users\gladm\bytescon\frontend\src\gb106
Copy-Item .\downloads\govcon-gb106-onboarding\migrations\2026_gb106_onboarding.sql C:\Users\gladm\bytescon\backend\migrations\
```

### 2. Add the schema models

Append the two models in `prisma/gb106.prisma` to your reconciled
`backend/prisma/schema.prisma`, then generate the client. House rule is
`db push`, but apply the additive SQL explicitly so the change is reviewable and
the live superset (notifications + SCW email work) is not at risk:

```powershell
# kill node first to avoid the EPERM rename on prisma generate (known on this box)
Stop-Process -Name node -ErrorAction SilentlyContinue
cd C:\Users\gladm\bytescon\backend
npx prisma generate

# apply the additive tables (idempotent, safe on the live superset)
Get-Content .\migrations\2026_gb106_onboarding.sql | docker compose exec -T db psql -U $env:POSTGRES_USER -d $env:POSTGRES_DB
```

Do NOT run `prisma db push --accept-data-loss` on this branch. It would drop the
live notification and SCW-email objects that are not yet in `schema.prisma`.

### 3. Mount the backend (one import, one call in the server bootstrap)

```ts
import { mountGB106 } from './gb106/mount.gb106';

mountGB106({
  app,
  prisma,
  basePath: '/api/onboarding',
  resolveTenant: (req) =>
    req.tenant
      ? {
          tenantId: req.tenant.id,
          businessDomain: req.tenant.businessDomain ?? 'freight_brokerage',
          naicsCodes: req.tenant.naicsCodes ?? [],
          isSdvosb: !!req.tenant.isSdvosb,
          yearsInBusiness: req.tenant.yearsInBusiness ?? 0,
          completedProgramCodes: req.tenant.completedProgramCodes ?? [],
        }
      : null,
  // optional, enable the daily freshness scan with your existing Redis-backed queue:
  // freshness: { queue: onboardingQueue, createWorker: (name, proc) => new Worker(name, proc, { connection }) },
});
```

### 4. Seed the reference table

```powershell
cd C:\Users\gladm\bytescon\backend
npx ts-node src\gb106\scripts\seed.gb106.ts
# or, in the running backend container after build:
# docker compose exec backend node dist/gb106/scripts/seed.gb106.js
```

### 5. Mount the frontend (behind a flag, GB-105 pattern)

Add to `frontend/.env`:

```
VITE_PLATFORM_ONBOARDING_ENABLED=true
```

Render the panel in the target page, gated on the flag:

```tsx
import { OnboardingPanel } from '../gb106/components/OnboardingPanel';
import { onboardingApi } from '../services/api'; // implement getPlan / updateProgress

{import.meta.env.VITE_PLATFORM_ONBOARDING_ENABLED === 'true' && (
  <OnboardingPanel api={onboardingApi} editable />
)}
```

### 6. Rebuild containers

```powershell
cd C:\Users\gladm\bytescon
docker compose build backend frontend
docker compose up -d backend frontend
```

## Verify the core before integrating

The dependency-free core (types + seed + logic + harness) typechecks under strict
mode and the harness asserts the expected behavior:

```powershell
cd .\govcon-gb106-onboarding
npm install --save-dev typescript ts-node @types/node
npx tsc -p tsconfig.core.json          # strict typecheck, expect clean
npx ts-node src\verify\demo.gb106.ts   # expect: ALL CHECKS PASSED
```

Expected harness output for a Bytes Platform profile (SDVOSB freight broker, SAM
done, not yet certified): TMSS 2.0 ranks first among vehicles at relevance 85
(CORE), flagged for window verification and blocked until the window is
confirmed; GSA MAS is actionable now; Polaris is peripheral and blocked behind
SDVOSB certification; the recommended next step is SBA VetCert.

## API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/onboarding/plan` | Scored, gated plan for the current tenant |
| GET | `/api/onboarding/programs` | Raw reference catalog |
| PUT | `/api/onboarding/progress` | Record progress: `{ programCode, status, notes? }` |

## Endpoints to add to the existing notification work (optional)

When a `NEEDS_VERIFICATION` item is resolved or a tracked window opens, the
freshness job result is a natural trigger for the GB-103 client match
notification channel. Left as an integration point, not wired here, to keep the
module additive.
