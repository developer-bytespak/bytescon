/**
 * Input schema for the `get_billing_status` tool.
 *
 * No inputs: the tenant comes from the resolved bearer token, never from
 * tool arguments. Reads Subscription, SubscriptionPlan, and an Invoice
 * summary from the platform database only; no Stripe API calls and no
 * payment-method data.
 */
import { z } from "zod";

export const getBillingStatusInputShape = {};

export const GetBillingStatusInput = z.object(getBillingStatusInputShape);
export type GetBillingStatusInputT = z.infer<typeof GetBillingStatusInput>;

export interface BillingSubscription {
  status: string;
  billing_cycle: string;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  trial_ends_at: string | null;
}

export interface BillingPlan {
  name: string;
  slug: string;
  monthly_price_usd: number | null;
  annual_price_usd: number | null;
  max_users: number;
  max_clients: number;
  ai_calls_per_month: number;
}

export interface BillingLatestInvoice {
  invoice_number: string;
  status: string;
  total_usd: number | null;
  period_start: string;
  period_end: string;
  due_at: string;
  paid_at: string | null;
}

export interface GetBillingStatusPayload {
  subscription: BillingSubscription | null;
  plan: BillingPlan | null;
  invoices: {
    count: number;
    latest: BillingLatestInvoice | null;
  };
}
