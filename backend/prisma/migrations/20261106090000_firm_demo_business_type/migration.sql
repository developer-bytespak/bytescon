-- Which business type a demo account's sample data was built for. Null on every normal firm.
ALTER TABLE "consulting_firms" ADD COLUMN "demoBusinessType" TEXT;
