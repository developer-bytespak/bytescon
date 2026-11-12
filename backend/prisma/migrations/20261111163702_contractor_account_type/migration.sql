-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('CONSULTING', 'CONTRACTOR');

-- AlterTable
ALTER TABLE "client_companies" ADD COLUMN     "isSelf" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "consulting_firms" ADD COLUMN     "accountType" "AccountType" NOT NULL DEFAULT 'CONSULTING';
