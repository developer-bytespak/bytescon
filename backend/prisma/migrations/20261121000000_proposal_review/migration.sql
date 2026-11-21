-- The Review step: the whole proposal read in its template and confirmed ready.
ALTER TABLE "proposals" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "proposals" ADD COLUMN "reviewedByUserId" TEXT;
