-- Clients archived by a switch between consulting and contractor accounts kept
-- isActive = true, so they still showed in client lists (including a consulting
-- firm's own record). Archived now always means inactive, as the Archive button does.
UPDATE "client_companies" SET "isActive" = false WHERE "archivedAt" IS NOT NULL AND "isActive" = true;
