-- Demo accounts: full access until this moment, then locked out.
ALTER TABLE "consulting_firms" ADD COLUMN "demoExpiresAt" TIMESTAMP(3);
