// Runs the real credits.* code path against core's InMemoryLedger. No test framework — prints
// balances at each step; compare byte-for-byte against py/examples/smoke.py's stdout.
import { FixedClock, InMemoryLedger, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import { grantForPeriod, consume, topup, grantPromo, grantTrial, manualGrant, manualRevoke, clawback, expireDue, } from 'boilpayment-credits';
async function main() {
    const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const policy = resolvePolicy(); // DEFAULT_POLICY: rollover='none'
    const plan = {
        id: 'plan_a',
        name: 'Plan A',
        interval: 'month',
        creditsPerPeriod: 100,
        usageIncluded: 0,
        trialDays: 0,
        prices: [{ currency: 'USD', amountMinor: 1000 }],
    };
    const period = { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') };
    const sub = {
        id: 'sub_1',
        customerId: 'cust_1',
        planId: plan.id,
        provider: 'stripe',
        providerRef: 'stripe_sub_1',
        status: 'active',
        currentPeriod: period,
        anchorDay: 1,
        cancelAtPeriodEnd: false,
        graceUntil: null,
        billingKey: null,
        scheduledPlanId: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
    };
    const payment = {
        id: 'pay_1',
        customerId: 'cust_1',
        provider: 'stripe',
        providerRef: 'pi_1',
        subscriptionId: sub.id,
        amount: { amountMinor: 1000, currency: 'USD' },
        status: 'succeeded',
        kind: 'subscription',
        period,
        occurredAt: clock.now(),
        failure: null,
    };
    const print = async (label) => {
        const balance = await ledger.balance('cust_1', undefined, clock.now());
        console.log(`${label}: balance=${balance.available}`);
    };
    await grantForPeriod({ sub, plan, period, payment, policy, ledger, clock });
    await print('01_grant_for_period');
    await consume({ customerId: 'cust_1', amount: 30, policy, ledger, clock, idempotencyKey: 'consume_1' });
    await print('02_consume_30');
    const topupPayment = { ...payment, id: 'pay_topup_1', providerRef: 'pi_topup_1', kind: 'topup', amount: { amountMinor: 500, currency: 'USD' } };
    await topup({ customerId: 'cust_1', payment: topupPayment, credits: 50, policy, ledger, clock });
    await print('03_topup_50');
    await grantPromo({ customerId: 'cust_1', amount: 20, ledger, clock, idempotencyKey: 'promo_1' });
    await print('04_grant_promo_20');
    await grantTrial({ customerId: 'cust_1', amount: 10, ledger, clock, idempotencyKey: 'trial_1' });
    await print('05_grant_trial_10');
    await manualGrant({ customerId: 'cust_1', pool: 'paid', amount: 5, reason: 'goodwill', actor: 'admin', ledger, clock, idempotencyKey: 'manual_grant_1' });
    await print('06_manual_grant_5');
    await clawback({
        customerId: 'cust_1',
        amount: 15,
        policy,
        ledger,
        clock,
        reason: 'chargeback',
        reference: { subscriptionId: sub.id },
        actor: 'system',
        idempotencyKey: 'revoke:chargeback:1',
        shortfall: 'clamp_to_zero',
    });
    await print('07_clawback_15');
    await manualRevoke({ customerId: 'cust_1', pool: 'promo', amount: 5, reason: 'abuse', actor: 'admin', ledger, clock, idempotencyKey: 'manual_revoke_1' });
    await print('08_manual_revoke_5');
    const before = await expireDue({ ledger, clock, customerId: 'cust_1' });
    console.log(`09_expire_due_before_expiry: entries=${before.entries.length}`);
    clock.advance(32 * 86_400_000); // past Feb 1 — the Jan grant's expiresAt
    await print('10_after_advance_past_expiry');
    const after = await expireDue({ ledger, clock, customerId: 'cust_1' });
    console.log(`11_expire_due_after_expiry: entries=${after.entries.length}`);
    await print('12_final');
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=smoke.js.map