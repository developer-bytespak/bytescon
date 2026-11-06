-- SAM.gov requests a job spent, and how far an on-demand demo pull got. Nullable; existing rows are untouched.
ALTER TABLE "ingestion_jobs" ADD COLUMN "samRequests" INTEGER;
ALTER TABLE "ingestion_jobs" ADD COLUMN "samCursor" JSONB;
