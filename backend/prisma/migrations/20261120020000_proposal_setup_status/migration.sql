-- A proposal sets itself up when it starts (documents, compliance requirements,
-- sections); these say whether that is still running and what it did.
ALTER TABLE "proposals" ADD COLUMN "setupStatus" TEXT;
ALTER TABLE "proposals" ADD COLUMN "setupNote" TEXT;
