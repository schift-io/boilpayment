// Runs the real lifecycle.* (+ transitively credits.*) code path against core's in-memory
// reference implementations. No test framework — prints balances/state at each step; compare
// byte-for-byte against py/examples/smoke.py's stdout.
import { CollectingNotifier, FixedClock, InMemoryLedger, InMemoryRepo, PaymentKitError, SequentialIdGen, resolvePolicy, } from '@schift/payment-kit-core';
import { upgrade, downgrade, dunning } from '@schift/payment-kit-lifecycle';
import { onRenewalPaid } from '@schift/payment-kit-lifecycle';
import { consume } from '@schift/payment-kit-credits';
// Minimal canned PaymentProvider — only changeSubscription is actually invoked by this scenario
// (upgrade/downgrade), and its return value is discarded by lifecycle. Everything else throws if
// hit, so a real call site accidentally exercising it would fail loudly.
class FakeProvider {
    name = 'stripe';
    capabilities() {
        return { nativeSubscriptions: true, partialRefund: true, meters: false, scheduling: 'provider', webhookSignature: true };
    }
    async createCustomer() {
        return { ref: 'cus_fake' };
    }
    async createCheckout(_input) {
        throw new Error('not used in this scenario');
    }
    async getPayment() {
        throw new Error('not used in this scenario');
    }
    async listPayments() {
        return [];
    }
    async getSubscription() {
        throw new Error('not used in this scenario');
    }
    async changeSubscription() {
        return DUMMY_SUB; // lifecycle discards this return value; canned for interface compliance
    }
    async cancelSubscription() {
        return DUMMY_SUB;
    }
    async chargeBillingKey() {
        throw new Error('not used in this scenario');
    }
    async refund() {
        throw new Error('not used in this scenario');
    }
    async reportUsage() { }
    async verifyWebhook() {
        throw new Error('not used in this scenario');
    }
}
let DUMMY_SUB; // assigned once `sub` exists, below
// EC:F — Toss-shaped self-scheduling provider: no native subscription tracking. getSubscription/
// changeSubscription/cancelSubscription throw exactly like the real Toss/PortOne provider
// implementations do, so if lifecycle.upgrade ever regressed into calling changeSubscription for a
// non-native provider, this smoke would fail loudly instead of silently passing.
class FakeSelfSchedulingProvider {
    name = 'toss';
    lastCharge = null;
    capabilities() {
        return { nativeSubscriptions: false, partialRefund: true, meters: false, scheduling: 'self', webhookSignature: false };
    }
    async createCustomer() {
        return { ref: 'cus_toss_fake' };
    }
    async createCheckout() {
        throw new Error('not used in this scenario');
    }
    async getPayment() {
        throw new Error('not used in this scenario');
    }
    async listPayments() {
        return [];
    }
    async getSubscription() {
        throw new PaymentKitError('unsupported', 'unsupported');
    }
    async changeSubscription() {
        throw new PaymentKitError('unsupported', 'unsupported');
    }
    async cancelSubscription() {
        throw new PaymentKitError('unsupported', 'unsupported');
    }
    async chargeBillingKey(input) {
        this.lastCharge = { amountMinor: input.amount.amountMinor, currency: input.amount.currency };
        return {
            id: `pay_${input.idempotencyKey}`,
            customerId: input.customerRef,
            provider: 'toss',
            providerRef: input.orderId,
            subscriptionId: null,
            amount: input.amount,
            status: 'succeeded',
            kind: 'subscription',
            period: null,
            occurredAt: new Date(),
            failure: null,
        };
    }
    async refund() {
        throw new Error('not used in this scenario');
    }
    async reportUsage() { }
    async verifyWebhook() {
        throw new Error('not used in this scenario');
    }
}
async function main() {
    const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    const provider = new FakeProvider();
    const ids = new SequentialIdGen('id_');
    const policy = resolvePolicy(); // DEFAULT_POLICY
    const planA = {
        id: 'plan_a',
        name: 'Plan A',
        interval: 'month',
        creditsPerPeriod: 100,
        usageIncluded: 0,
        trialDays: 0,
        prices: [{ currency: 'USD', amountMinor: 1000 }],
    };
    const planB = {
        id: 'plan_b',
        name: 'Plan B',
        interval: 'month',
        creditsPerPeriod: 300,
        usageIncluded: 0,
        trialDays: 0,
        prices: [{ currency: 'USD', amountMinor: 3000 }],
    };
    await repo.plans.put(planA);
    await repo.plans.put(planB);
    let sub = {
        id: 'sub_1',
        customerId: 'cust_1',
        planId: planA.id,
        provider: 'stripe',
        providerRef: 'stripe_sub_1',
        status: 'active',
        currentPeriod: { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') },
        anchorDay: 1,
        cancelAtPeriodEnd: false,
        graceUntil: null,
        billingKey: null,
        scheduledPlanId: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
    };
    DUMMY_SUB = sub;
    await repo.subscriptions.put(sub);
    const print = async (label) => {
        const balance = await ledger.balance(sub.customerId, undefined, clock.now());
        console.log(`${label}: balance=${balance.available} status=${sub.status} planId=${sub.planId} periodStart=${sub.currentPeriod.start.toISOString()}`);
    };
    // 1. onRenewalPaid grants the first period's credits (Jan 1 - Feb 1, plan A, $10 -> 100 credits)
    const payment1 = {
        id: 'pay_1',
        customerId: sub.customerId,
        provider: 'stripe',
        providerRef: 'pi_1',
        subscriptionId: sub.id,
        amount: { amountMinor: 1000, currency: 'USD' },
        status: 'succeeded',
        kind: 'subscription',
        period: null, // falls back to sub.currentPeriod — see renewal.ts
        occurredAt: clock.now(),
        failure: null,
    };
    const r1 = await onRenewalPaid({ sub, payment: payment1, policy, ledger, repo, clock });
    sub = r1.sub;
    await print('01_renewal_paid_100');
    // 2. consume 30
    await consume({ customerId: sub.customerId, amount: 30, policy, ledger, clock, idempotencyKey: 'consume_1' });
    await print('02_consume_30');
    // 3. mid-cycle upgrade to plan B on Jan 16 (default policy: immediate_prorate_reset_anchor, full_delta)
    clock.advance(15 * 86_400_000); // Jan 1 -> Jan 16
    const u1 = await upgrade({ sub, newPlan: planB, policy, provider, ledger, repo, clock, ids });
    sub = u1.sub;
    console.log(`03_upgrade_full_delta: creditDelta=${u1.creditDelta} anchorDay=${sub.anchorDay}`);
    await print('03_upgrade_full_delta');
    // 4. consume 250 (leaves only 20 — sets up a clawback shortfall below)
    await consume({ customerId: sub.customerId, amount: 250, policy, ledger, clock, idempotencyKey: 'consume_2' });
    await print('04_consume_250');
    // 5. downgrade back to plan A, immediate_clawback (custom policy) — wants to revoke 200 but only
    //    20 is available, so clamp_to_zero clamps the revoke and reports the shortfall.
    const policyClawback = resolvePolicy({ downgrade: { mode: 'immediate_clawback' } });
    const d1 = await downgrade({ sub, newPlan: planA, policy: policyClawback, provider, ledger, repo, clock, ids });
    sub = d1.sub;
    console.log(`05_downgrade_clawback: revoked=${d1.clawback?.revoked ?? 0} shortfall=${d1.clawback?.shortfall ?? 0}`);
    await print('05_downgrade_clawback');
    // 6. renewal payment fails -> grace period starts
    const f1 = await dunning.onPaymentFailed({ sub, policy, repo, notifier, clock });
    sub = f1.sub;
    console.log(`06_payment_failed: status=${sub.status} graceUntil=${sub.graceUntil?.toISOString()}`);
    // 7. payment recovers -> regrant current period
    const payment2 = {
        id: 'pay_2',
        customerId: sub.customerId,
        provider: 'stripe',
        providerRef: 'pi_2',
        subscriptionId: sub.id,
        amount: { amountMinor: 1000, currency: 'USD' },
        status: 'succeeded',
        kind: 'subscription',
        period: null,
        occurredAt: clock.now(),
        failure: null,
    };
    const rec1 = await dunning.onRecovered({ sub, payment: payment2, policy, ledger, repo, clock });
    sub = rec1.sub;
    await print('07_recovered');
    console.log(`notifications=${notifier.sent.map((n) => n.type).join(',')}`);
    // 8. EC:F — mid-cycle upgrade on a self-scheduling (Toss-shaped) provider: nativeSubscriptions is
    //    false, so upgrade() must NOT call changeSubscription (it would throw PaymentKitError
    //    'unsupported' here, exactly like the real Toss/PortOne providers) — instead it charges the
    //    prorated money delta directly via chargeBillingKey.
    const tossProvider = new FakeSelfSchedulingProvider();
    let subToss = {
        id: 'sub_toss_1',
        customerId: 'cust_toss_1',
        planId: planA.id,
        provider: 'toss',
        providerRef: 'toss_sub_1',
        status: 'active',
        currentPeriod: { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') },
        anchorDay: 1,
        cancelAtPeriodEnd: false,
        graceUntil: null,
        billingKey: 'bk_toss_1',
        scheduledPlanId: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
    };
    await repo.subscriptions.put(subToss);
    const paymentToss = {
        id: 'pay_toss_1',
        customerId: subToss.customerId,
        provider: 'toss',
        providerRef: 'toss_pi_1',
        subscriptionId: subToss.id,
        amount: { amountMinor: 1000, currency: 'USD' },
        status: 'succeeded',
        kind: 'subscription',
        period: null,
        occurredAt: clock.now(),
        failure: null,
    };
    const rToss1 = await onRenewalPaid({ sub: subToss, payment: paymentToss, policy, ledger, repo, clock });
    subToss = rToss1.sub;
    const uToss = await upgrade({ sub: subToss, newPlan: planB, policy, provider: tossProvider, ledger, repo, clock, ids });
    subToss = uToss.sub;
    const balanceToss = await ledger.balance(subToss.customerId, undefined, clock.now());
    console.log(`08_self_scheduling_upgrade: changeSubscription_called=false creditDelta=${uToss.creditDelta} balance=${balanceToss.available} planId=${subToss.planId} chargedMinor=${tossProvider.lastCharge?.amountMinor} chargedCurrency=${tossProvider.lastCharge?.currency}`);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=smoke.js.map