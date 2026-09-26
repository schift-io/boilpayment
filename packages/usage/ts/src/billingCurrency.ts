import { PaymentKitError } from 'boilpayment-core';
import type { Repo } from 'boilpayment-core';

/** Resolve a selected currency or an unambiguous plan price; never invent money units. */
export async function billingCurrency(repo: Repo, planId: string, selected?: string): Promise<string> {
  if (selected !== undefined) {
    if (/^[A-Z]{3}$/.test(selected)) return selected;
    throw new PaymentKitError('Billing currency must be an uppercase ISO currency code', 'billing_currency_required');
  }
  const plan = await repo.plans.get(planId);
  const currencies = new Set(plan?.prices.map((price) => price.currency));
  if (currencies.size === 1) {
    for (const currency of currencies) {
      if (/^[A-Z]{3}$/.test(currency)) return currency;
    }
  }
  throw new PaymentKitError('Select a billing currency when the plan has no unique currency', 'billing_currency_required');
}
