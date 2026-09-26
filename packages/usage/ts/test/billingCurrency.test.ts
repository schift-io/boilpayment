import { expect, it } from 'vitest';
import { InMemoryRepo } from 'boilpayment-core';
import { billingCurrency } from '../src/billingCurrency.js';

it.each([['KRW'], ['USD', 'KRW'], []])('requires a selection unless plan currencies %j are unique', async (...currencies) => {
  // Given configured plan prices.
  const repo = new InMemoryRepo();
  await repo.plans.put({ id: 'plan', name: 'Pro', interval: 'month', creditsPerPeriod: 0, usageIncluded: 0, trialDays: 0, prices: currencies.map((currency) => ({ currency, amountMinor: 1000 })) });
  // When resolving the currency, then ambiguity is rejected.
  const result = billingCurrency(repo, 'plan');
  if (currencies.length === 1) await expect(result).resolves.toBe('KRW');
  else await expect(result).rejects.toMatchObject({ code: 'billing_currency_required' });
});

it('uses the selected currency when the caller supplies it', async () => {
  // Given a currency selected during checkout.
  const repo = new InMemoryRepo();
  // When resolving, then that selection is preserved.
  await expect(billingCurrency(repo, 'plan', 'KRW')).resolves.toBe('KRW');
});
