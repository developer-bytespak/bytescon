-- Civilian-program sources (E-Rate, Rural Health Care, ...): open to
-- commercial vendors without federal contractor registration.

-- AlterEnum
ALTER TYPE "SourceCategory" ADD VALUE 'CIVILIAN';

-- AlterEnum
ALTER TYPE "OpportunitySource" ADD VALUE 'CIVILIAN';
