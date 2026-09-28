import { describe, expect, it } from 'vitest';
import { generateIndexPy } from '../src/generate/py-entry.js';
import { kitchenSinkConfig } from './helpers.js';

const config = kitchenSinkConfig();
config.models = ['topup'];
config.goods = ['credits'];

const generatedPy = generateIndexPy(config);

describe('[EC:A85] generated banned-customer top-up wiring', () => {
  it('passes the notifier to the Python webhook purchased-grant path', () => {
    // Given a generated credits + top-up kit, when its webhook adapter is generated.
    const expectedGrant =
      'return await apply_purchased_grant(ApplyPurchasedGrantInput(customer_id=customer_id, payment_id=payment.id, policy=policy, providers=providers, repo=repo, ledger=ledger, clock=clock, ids=ids, notifier=notifier, grants=support_grants))';

    // Then a banned-customer grant can open and notify the single refund-review case.
    expect(generatedPy).toContain(expectedGrant);
  });
});
