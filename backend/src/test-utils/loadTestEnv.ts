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
