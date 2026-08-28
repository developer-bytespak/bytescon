-- =============================================================
-- Backfill: lowercase + trim all stored email addresses.
--
-- Required because the auth code now normalizes emails on write
-- and lookup, but historical rows may have mixed-case values
-- (e.g. "Johngladmon917@gmail.com") that won't match login attempts
-- using the lowercase form a user is likely to type.
--
-- Run order matters:
--   1. PRE-CHECK that no two rows would collide on a unique index
--      after lowercasing. If a collision exists, manual reconciliation
--      is required first (decide which row to keep).
--   2. UPDATE only rows whose stored email differs from its
--      normalized form, so unchanged rows aren't churned.
--
-- Usage:
--   docker exec -i bytescon_postgres \
--     psql -U bytescon_user -d bytescon_platform \
--     -f /path/to/normalize_emails.sql
-- =============================================================

\echo '--- Collision check: users ---'
SELECT LOWER(TRIM(email)) AS normalized, COUNT(*) AS n, ARRAY_AGG(email) AS originals
FROM users
GROUP BY LOWER(TRIM(email))
HAVING COUNT(*) > 1;

\echo '--- Collision check: client_portal_users ---'
SELECT LOWER(TRIM(email)) AS normalized, COUNT(*) AS n, ARRAY_AGG(email) AS originals
FROM client_portal_users
GROUP BY LOWER(TRIM(email))
HAVING COUNT(*) > 1;

\echo '--- Collision check: beta_access_requests ---'
SELECT LOWER(TRIM(email)) AS normalized, COUNT(*) AS n, ARRAY_AGG(email) AS originals
FROM beta_access_requests
GROUP BY LOWER(TRIM(email))
HAVING COUNT(*) > 1;

-- If any of the above printed rows, STOP HERE and resolve the
-- duplicates before running the UPDATEs below.
--
-- For users / client_portal_users (which have @unique on email):
--   delete or rename the older / less-active row, e.g.:
--     UPDATE users SET email = email || '.dup-2026-05-06' WHERE id = '...';

BEGIN;

UPDATE users
SET email = LOWER(TRIM(email))
WHERE email <> LOWER(TRIM(email));

UPDATE client_portal_users
SET email = LOWER(TRIM(email))
WHERE email <> LOWER(TRIM(email));

UPDATE beta_access_requests
SET email = LOWER(TRIM(email))
WHERE email <> LOWER(TRIM(email));

-- Final verification — should print 0 rows for each table.
\echo '--- Post-normalize verification (expect 0 rows each) ---'
SELECT COUNT(*) AS users_unnormalized
FROM users WHERE email <> LOWER(TRIM(email));
SELECT COUNT(*) AS client_portal_unnormalized
FROM client_portal_users WHERE email <> LOWER(TRIM(email));
SELECT COUNT(*) AS beta_unnormalized
FROM beta_access_requests WHERE email <> LOWER(TRIM(email));

COMMIT;
