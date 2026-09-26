import { describe, expect, it } from 'vitest';
import { collectPlans } from '../src/plans.js';
import { checkoutConfigurationErrors } from '../src/commands/check.js';
import { buildConfig, samplePlan } from './helpers.js';

describe('sellable plan setup', () => {
  it('defaults a Toss seller to KRW without inventing native price references', async () => {
    const config = buildConfig({ providers: ['toss'] });
    const plans = await collectPlans(config, { yes: true });
    expect(plans[0]?.prices).toEqual([{ currency: 'KRW', amountMinor: 9900 }]);
  });

  it('keeps a native provider draft unready until its real product reference is configured', () => {
    const config = buildConfig({ providers: ['stripe'] });
    config.plans = [samplePlan()];
    expect(checkoutConfigurationErrors(config)).toHaveLength(1);
  });

  it('accepts the selected Stripe price mapping', () => {
    const config = buildConfig({ providers: ['stripe'] });
    config.plans = [samplePlan({ prices: [{ currency: 'USD', amountMinor: 1999, providerPriceRefs: { stripe: 'price_test_existing' } }] })];
    expect(checkoutConfigurationErrors(config)).toEqual([]);
  });
});
