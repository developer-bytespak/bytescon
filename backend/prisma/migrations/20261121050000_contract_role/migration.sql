-- A contract records whether its holder is the prime or a subcontractor, and
-- the prime (a partner) when it is a subcontractor.
CREATE TYPE "ContractRole" AS ENUM ('PRIME', 'SUB');
ALTER TABLE "contracts" ADD COLUMN "ourRole" "ContractRole" NOT NULL DEFAULT 'PRIME';
ALTER TABLE "contracts" ADD COLUMN "primePartnerId" TEXT;
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_primePartnerId_fkey"
  FOREIGN KEY ("primePartnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "contracts_primePartnerId_idx" ON "contracts"("primePartnerId");
