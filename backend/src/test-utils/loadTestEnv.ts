// =============================================================
// Vitest env bootstrap (runs as a setupFile BEFORE any test
// module, and therefore before testClient.ts imports
// ../config/database and constructs the Prisma singleton).
//
// Loads backend/.env.test so a dev machine with the local
// Postgres up but no DATABASE_URL exported still resolves a
// usable connection string. override is left OFF (the dotenv
// default), so an already exported DATABASE_URL (for example
// the CI job's bytescon_platform_test) is never clobbered and
// always wins.
// =============================================================
import { config as loadDotenv } from 'dotenv'
import path from 'path'

// .env.test.local (git-ignored) loads FIRST so a real per-machine test DB
// (e.g. a Neon test database) wins over the tracked localhost default in
// .env.test — dotenv never overrides an already-set variable.
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env.test.local') })
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env.test') })

// config/config.ts also loads backend/.env, which on a developer's machine can
// hold real keys. Tests must never call OpenAI, Anthropic or SAM.gov with
// them: it costs money, spends SAM.gov's small daily allowance and makes tests
// slow or flaky. dotenv never overrides a variable that already exists, so
// setting these to empty here keeps .env's values out. A key exported on
// purpose (e.g. by CI) is left alone, and a test that needs a key sets its own.
const EXTERNAL_KEYS = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'INSIGHT_ENGINE_API_KEY',
  'SAM_API_KEY', 'SAM_GOV_API_KEY', 'DATA_GOV_API_KEY',
]
for (const key of EXTERNAL_KEYS) {
  if (!(key in process.env)) process.env[key] = ''
}
