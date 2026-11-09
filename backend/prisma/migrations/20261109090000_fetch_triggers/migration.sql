-- Why each fetch ran and who started it, for the fetch history page. Nullable; existing rows are untouched.
ALTER TABLE "ingestion_jobs" ADD COLUMN "trigger" TEXT;
ALTER TABLE "ingestion_jobs" ADD COLUMN "triggerDetail" TEXT;
ALTER TABLE "source_sync_runs" ADD COLUMN "trigger" TEXT;
ALTER TABLE "source_sync_runs" ADD COLUMN "triggerDetail" TEXT;
