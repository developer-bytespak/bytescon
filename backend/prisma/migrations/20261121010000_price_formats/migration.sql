-- Price formats: most solicitations price a schedule of line items (CLINs),
-- some labor rates or a full cost breakdown (services/priceFormat.ts).
ALTER TABLE "pricing_workspaces" ADD COLUMN "priceFormat" TEXT;
ALTER TABLE "pricing_workspaces" ADD COLUMN "quoteValidityDays" INTEGER;
ALTER TABLE "pricing_workspaces" ADD COLUMN "promptPayDiscount" TEXT;
ALTER TABLE "pricing_workspaces" ADD COLUMN "itemsStatus" TEXT;
ALTER TABLE "pricing_workspaces" ADD COLUMN "itemsNote" TEXT;

CREATE TABLE "pricing_line_items" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "itemNumber" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,2) NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'EA',
    "unitPrice" DECIMAL(16,4),
    "periodLabel" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "pricing_line_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pricing_line_items_workspaceId_sortOrder_idx" ON "pricing_line_items"("workspaceId", "sortOrder");
CREATE INDEX "pricing_line_items_consultingFirmId_idx" ON "pricing_line_items"("consultingFirmId");
ALTER TABLE "pricing_line_items" ADD CONSTRAINT "pricing_line_items_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "pricing_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
