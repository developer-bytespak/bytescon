-- AlterTable
ALTER TABLE "consulting_firms" ALTER COLUMN "llmProvider" DROP NOT NULL,
ALTER COLUMN "llmProvider" DROP DEFAULT;

-- Existing rows holding the old column default were never a deliberate
-- choice: reset them to NULL so they follow the platform default. A firm
-- that wants a specific provider re-selects it in Settings.
UPDATE "consulting_firms" SET "llmProvider" = NULL WHERE "llmProvider" = 'claude';
