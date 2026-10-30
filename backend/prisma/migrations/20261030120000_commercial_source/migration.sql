-- Commercial sources (World Bank, UK Contracts Finder, EU TED, ...): open
-- tenders any commercial company can bid on, outside US federal channels.

-- AlterEnum
ALTER TYPE "SourceCategory" ADD VALUE 'COMMERCIAL';

-- AlterEnum
ALTER TYPE "OpportunitySource" ADD VALUE 'COMMERCIAL';
