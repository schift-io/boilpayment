# cs — pseudo spec

소스 오브 트루스. ts/py 구현은 이 섹션 ID를 `# EC:<id>` / `// EC:<id>` 주석으로 인용한다.
공개 API: `openCase` · `escalate` · `resolve` · `reject` · `reconcile` · `regrant` · `refundAssist` ·
`dispute` · `widget.{signToken,verifyToken}` · `churn.record` · `Metrics` · `CaseMeter` ·
`LicenseReporter`/`NoopLicenseReporter`/`HttpLicenseReporter` · `timeline` · `explain`
(docs/ARCHITECTURE.md §3.5, docs/CS_SERVER.md for the server contract `HttpLicenseReporter` talks to).

`refundAssist` does **not** import `boilpayment-refund` directly — it takes `refundEvaluate` /
`refundExecute` as injected function params (same shapes as `refund.evaluate` / `refund.execute`). This
keeps `cs` decoupled from `refund`'s package tree; the app (or the smoke example) wires the two
together by importing both and passing the functions in.

`ACTIVE_STATUSES = {'open', 'needs_human'}`. `BILLABLE_STATUSES = {'resolved_auto', 'resolved_human', 'rejected'}` (I5).

---

## [EC:I7][EC:I8] openCase

```pseudo
input: customerId, kind, referenceId, policy, repo, clock, ids, onCaseEvent?
existing = repo.csCases.list({customerId, kind, referenceId})
active = [c for c in existing if c.status in ACTIVE_STATUSES]
if active:
    return active[0]                      # I7 — dedupe, no new case
case = CsCase{id: ids.newId(), customerId, kind, status:'open', referenceId,
              policySnapshot: deepCopy(policy),      # I8 — snapshot policy at open time
              decision: None, churnReason: None, churnText: None,
              openedAt: clock.now(), resolvedAt: None}
repo.csCases.put(case)
onCaseEvent?({type:'opened', case, at: clock.now()})
return case
idempotency: (customerId, kind, referenceId) uniqueness while status in ACTIVE_STATUSES (I7)
```

## [EC:I3] escalate

```pseudo
input: case, repo, clock, reason, notifier?, onCaseEvent?
case.status = 'needs_human'
case.decision = {...(case.decision or {}), escalateReason: reason}
repo.csCases.put(case)
notifier?.send({type:'cs.needs_human', customerId: case.customerId,
                 payload:{caseId: case.id, kind: case.kind, reason}})
onCaseEvent?({type:'escalated', case, at: clock.now()})
return case
```

## resolve / reject

```pseudo
resolve(case, by: 'auto'|'human', decision, repo, clock, onCaseEvent?):
    case.status = 'resolved_auto' if by == 'auto' else 'resolved_human'
    case.decision = decision
    case.resolvedAt = clock.now()
    repo.csCases.put(case)
    onCaseEvent?({type:'resolved', case, at: clock.now()})
    return case

reject(case, reason, repo, clock, onCaseEvent?):
    case.status = 'rejected'
    case.decision = {reason}
    case.resolvedAt = clock.now()
    repo.csCases.put(case)
    onCaseEvent?({type:'resolved', case, at: clock.now()})
    return case
```

## Metrics (I4 support) / CaseMeter (I5)

```pseudo
class Metrics:
    events: CsMetricEvent[] = []
    record(event): events.append(event)               # the onCaseEvent hook implementation
    snapshot():
        return {
          countsByKind:   group events where type in ('opened') by case.kind -> count,
          countsByStatus: group events where type in ('resolved','escalated') by case.status -> count,
          durationsMsByKind: for type=='resolved' events, (case.resolvedAt - case.openedAt).ms grouped by case.kind,
          churnReasons:   group type=='churn' events by reason -> count,
        }

class CaseMeter:
    constructor(repo)
    countBillable(filter?): len([c for c in repo.csCases.list(filter) if c.status in BILLABLE_STATUSES])  # I5
```

## [EC:I5] license reporting

Optional (docs/CS_SERVER.md). With no API key the kit uses `NoopLicenseReporter`. With a key, the
SDK's job is limited to two things: report every resolved case transition, and ask the server
what the current entitlement is. No tier or price constants live in this SDK. Auth is a per-tenant API key
(`Authorization: Bearer <apiKey>`), not OAuth/session.

```pseudo
interface LicenseReporter:
    reportCase({caseId, kind, status, tenantRef?, occurredAt}) -> None   # POST {baseUrl}/cases
    entitlement() -> Entitlement | None                                  # GET  {baseUrl}/entitlement
    heartbeat() -> None                                                  # POST {baseUrl}/heartbeat

Entitlement = {tier, includedCasesPerMonth, usedThisMonth, overagePriceMinor, currency, hardLimit}

class NoopLicenseReporter(LicenseReporter):
    reportCase(...): pass       # v0 stub / no apiKey configured
    entitlement(...): return None
    heartbeat(...): return None
```

**Wiring** — `resolve()` and `reject()` (the two functions that flip a case into a BILLABLE_STATUS)
take an optional `reporter`. If given, after the case is persisted they call
`reporter.reportCase({caseId: case.id, kind: case.kind, status: case.status,
tenantRef: case.customerId, occurredAt: case.resolvedAt})`. `regrant`, `refundAssist`, and
`dispute` (all of which call `resolve`/`reject` internally) accept the same `reporter` param and
thread it straight through. `escalate` does NOT report (needs_human isn't billable).

```pseudo
class HttpLicenseReporter(LicenseReporter):
    constructor({apiKey, baseUrl = 'https://api.schift.io/paykit/v1' (placeholder, owner to confirm),
                 fetch? / http_call?, repo?})

    reportCase(input):
        try: POST {baseUrl}/cases  Authorization: Bearer {apiKey}  body: {caseId, kind, status, tenantRef, occurredAt}
             if not response.ok: raise
        except: enqueue(input)     # never throws to the caller

    enqueue(input):
        buffer.push(input)
        if repo: repo.outbox.put({id: "cs.license:{caseId}", kind: 'cs.license', payload: input,
                                    status: 'pending', attempts: 0, nextAttemptAt: input.occurredAt,
                                    createdAt: input.occurredAt})

    flush(): retries every buffered item; items that still fail stay queued. Returns {sent, remaining}.

    entitlement(): GET {baseUrl}/entitlement, Authorization header. Returns None on any failure.

    heartbeat(): POST {baseUrl}/heartbeat. Best-effort, never throws, no queueing.

idempotency: reportCase is idempotent by caseId **on the server** (POST {baseUrl}/cases dedupes
there) — the SDK does not need its own idempotency key for this call, only offline-queue retry
safety (repeating a successful POST is a server-side no-op).
offline rule: NO LicenseReporter method may throw out of the SDK's call sites (resolve/reject/
regrant/refundAssist/dispute run reportCase in their success path — a license-server outage must
never block a customer's case from resolving). HttpLicenseReporter enforces this by catching
every network/HTTP error internally.
```

---

## [EC:E1][EC:H4] reconcile

```pseudo
input: customerId?, providers, ledger, repo, policy, clock, ids, since, onCaseEvent?
customers = [repo.customers.get(customerId)] if customerId else repo.customers.list()
cases = []
for customer in customers (skip None):
    for pref in customer.providerRefs:
        provider = providers.get(pref.provider)
        if provider is None: continue
        payments = provider.listPayments({customerRef: pref.ref, since})
        for payment in payments:
            if payment.status != 'succeeded': continue
            if payment.kind == 'subscription':
                if payment.period is None: continue
                grantKey = "grant:%s:%s" % (payment.subscriptionId, payment.period.start.isoformat())
            elif payment.kind == 'topup':
                grantKey = "topup:%s" % payment.id
            else:
                continue                                    # overage payments aren't grant-backed
            grantEntries = ledger.entries(customer.id, {kind:'grant'})
            found = any(e.idempotencyKey == grantKey for e in grantEntries)
            if not found:
                case = openCase({customerId: customer.id, kind:'regrant', referenceId: grantKey,
                                  policy, repo, clock, ids, onCaseEvent})
                cases.append(case)
return cases
idempotency: openCase's own (customerId, kind, referenceId) dedupe (I7) — re-running reconcile is a no-op
             for grants already flagged.
```

### checkBalances (H4, optional)

```pseudo
input: ledger, repo, customerIds?
# Only runs if repo exposes a credit_balances-like snapshot table (schema-postgres §5); the core
# `Repo` contract (fixed, cannot be edited by this package) has no such table, so this degrades to
# a no-op with InMemoryRepo — documented as a contract gap in the final report.
snapshotTable = getattr(repo, 'creditBalances', None)
if snapshotTable is None: return []
mismatches = []
for customerId in (customerIds or all known customer ids):
    live = ledger.balance(customerId, 'paid').available
    snap = snapshotTable.get(customerId)
    if snap is not None and snap.available != live:
        mismatches.append({customerId, ledger: live, snapshot: snap.available})
return mismatches
```

## [EC:A18][EC:E1][EC:E2][EC:E14] regrant

```pseudo
input: case, ledger, repo, policy, clock, ids, plan, approvedBy?, onCaseEvent?
# plan: {customerId?, pool, amount, unitPriceMinor?, currency?, expiresAt?, idempotencyKey?, reason?}
# credits business rules (what/how much to grant) are owned by the `credits` package — cs only
# knows how to (re)play a grant the ledger is missing, using the caller-supplied plan.
require case.kind == regrant and plan.customerId in (None, case.customerId) and plan.amount > 0
mode = case.policySnapshot.cs.regrant.mode
if mode == 'off':
    return reject(case, 'cs.regrant.mode=off', repo, clock, onCaseEvent)
# This transition happens before runIdempotent: approval can resume the same case.
if mode == 'manual_approve' and approvedBy is blank:
    return escalate(case, repo, clock, 'cs.regrant.mode=manual_approve, awaiting approval',
                     onCaseEvent=onCaseEvent)
# mode == 'auto', or manual_approve with approvedBy set
idemKey = plan.idempotencyKey or case.referenceId        # E1/E14 — the ORIGINAL key; late webhook = no-op
result = ledger.append({customerId: plan.customerId or case.customerId, pool: plan.pool,
                         kind:'grant', amount: plan.amount, unitPriceMinor: plan.unitPriceMinor,
                         currency: plan.currency, expiresAt: plan.expiresAt, source:'regrant',
                         reference:{caseId: case.id}, idempotencyKey: idemKey, actor:'cs',
                         reason: plan.reason or ('regrant: case %s' % case.id)})
decision = {granted: not result.duplicated, entryId: result.entry.id, idempotencyKey: idemKey,
            approvedBy: approvedBy}
return resolve(case, 'auto', decision, repo, clock, onCaseEvent)   # E2 — duplicated append still resolves
idempotency: idemKey (defaults to case.referenceId, e.g. the grantKey reconcile produced)
```

`plan` and `approvedBy` are trusted application inputs, never AI/customer authority. The host must verify
original grant entitlement and approver identity before calling. Current reconcile records do not contain
trusted expected-credit amounts, so automatic amount-evidence verification is not implemented here.
The retained `policy` parameter is compatibility-only; execution uses the case snapshot.

## [EC:D*][EC:I1][EC:I2] refundAssist

```pseudo
input: case, payment, sub?, policy, ledger, repo, clock, ids, provider, refundEvaluate, refundExecute,
       requestedAmount?, providerFeeMinor?, notifier?, churnReason?, churnText?, onCaseEvent?
policy = case.policySnapshot
require payment.customerId == case.customerId
decision = refundEvaluate({payment, sub, policy, ledger, repo, clock, requestedAmount, providerFeeMinor})
if not decision.eligible:
    return reject(case, decision.reason, repo, clock, onCaseEvent)

# I2 — fraud/velocity: too many refunds recently -> force human review regardless of decision.needsHuman
windowStart = clock.now() - policy.cs.fraud.windowDays days
recent = len([r for r in repo.refunds.list({customerId: case.customerId})
              if r.status == 'succeeded' and r.createdAt >= windowStart])
if recent >= policy.cs.fraud.refundVelocity:
    return escalate(case, repo, clock, 'I2 fraud: %d refunds in %dd >= velocity %d'
                     % (recent, policy.cs.fraud.windowDays, policy.cs.fraud.refundVelocity),
                     notifier=notifier, onCaseEvent=onCaseEvent)

# I1 — auto-approve limits (already folded into decision.needsHuman by refund.evaluate)
if decision.needsHuman:
    return escalate(case, repo, clock, decision.reason, notifier=notifier, onCaseEvent=onCaseEvent)

refund = refundExecute({decision, provider, ledger, repo, clock, ids})
if refund.status != 'succeeded':
    case.decision = {decision, refund}
    return escalate(case, reason=refund.failure?.userMessage or refund.status)
resolved = resolve(case, 'auto', {decision: decision, refund: refund}, repo, clock, onCaseEvent)
if churnReason is not None:
    churn.record({customerId: case.customerId, reason: churnReason, text: churnText, case: resolved,
                   repo, clock})                          # I4 — recorded on the case
return resolved
```

## [EC:B11][EC:D9] dispute

```pseudo
# 2026-09-09: two money-losing bugs fixed here (see the 2026-09-09 edge-case audit #1, #D9):
#   - won never gave the revoked credits back  -> restoreDisputedGrants (mandatory, not a policy)
#   - onLost='revoke_only' revoked nothing when onOpen was 'freeze_customer'/'none'
# The revoke is attributed PER GRANT BUCKET (reference.grantId), like refund.execute, so expiry (B14)
# and the restore can both see which bucket each unit came from.

function revokeDisputedGrants(ledger, customerId, paymentId, caseId) -> revokedNow:
    all = ledger.entries(customerId, {pool:'paid'})
    grants = [e for e in all if e.kind=='grant' and e.reference.paymentId == paymentId]
    left = max(0, sum(g.amount for g in grants)
                  - sum(-e.amount for e in all
                        if e.kind=='revoke' and e.source=='dispute' and e.reference.caseId==caseId))
    for g in grants while left > 0:                       # bucket order = ledger order
        used = sum(e.amount for e in all if e.kind!='grant' and e.reference.grantId==g.id)
        take = min(max(0, g.amount + used), left)
        ledger.append({kind:'revoke', amount:-take, source:'dispute',
                       reference:{paymentId, caseId, grantId: g.id},
                       idempotencyKey: "revoke:dispute:%s:%s" % (caseId, g.id)})   # idempotent
        left -= take
    if left > 0:                                          # already spent -> balance may go negative
        ledger.append({kind:'revoke', amount:-left, source:'dispute',
                       reference:{paymentId, caseId},
                       idempotencyKey: "revoke:dispute:%s" % caseId})
    return amount actually appended (0 when every key was a duplicate)

function restoreDisputedGrants(ledger, customerId, caseId) -> restoredNow:
    for r in ledger.entries(customerId, {pool:'paid'}) if r.kind=='revoke' and r.source=='dispute'
                                                       and r.reference.caseId == caseId:
        origin = the grant r.reference.grantId points at (may be None for the spent remainder)
        ledger.append({kind:'grant', amount:-r.amount, source:'dispute',
                       reference:{paymentId:r.reference.paymentId, caseId, grantId:r.reference.grantId},
                       idempotencyKey: "restore:dispute:%s:%s" % (caseId, r.reference.grantId or 'remainder'),
                       unitPriceMinor: origin.unitPriceMinor, currency: origin.currency,
                       expiresAt: origin.expiresAt})     # ORIGINAL expiry: credits that would have
                                                          # lapsed during the dispute stay lapsed
    return amount actually appended (0 on replay)

input: event, policy, ledger, repo, notifier, clock, ids, onCaseEvent?
if event.type == 'dispute.opened':
    payment = first(repo.payments.list({providerRef: event.paymentRef})) if event.paymentRef else None
    customerId = payment.customerId if payment else (event.customerRef or 'unknown')
    case = openCase({customerId, kind:'dispute', referenceId: event.paymentRef or event.id,
                      policy, repo, clock, ids, onCaseEvent})
    onOpen = policy.dispute.onOpen
    if onOpen == 'freeze_customer':
        customer = repo.customers.get(customerId)
        if customer: customer.status = 'frozen'; repo.customers.put(customer)      # B11
    elif onOpen == 'revoke_disputed_grant' and payment is not None:
        revokeDisputedGrants(ledger, customerId, payment.id, case.id)              # B11
    # else 'none' — no side effect
    return escalate(case, repo, clock, 'dispute opened', notifier=notifier, onCaseEvent=onCaseEvent)

elif event.type == 'dispute.closed':
    referenceId = event.paymentRef or event.id
    cases = repo.csCases.list({kind:'dispute', referenceId: referenceId})
    case = cases[0] if cases else openCase({customerId: event.customerRef or 'unknown', kind:'dispute',
                                             referenceId, policy, repo, clock, ids, onCaseEvent})
    # D9 — outcome isn't a NormalizedEvent field (provider-specific); read it from event.raw['outcome']
    # ('won' | 'lost'). Documented contract gap: a first-class field would be cleaner.
    outcome = event.raw.get('outcome') if isinstance(event.raw, dict) else None
    customer = repo.customers.get(case.customerId)
    payment = first(repo.payments.list({providerRef: event.paymentRef})) if event.paymentRef else None

    if outcome == 'lost':
        # BOTH onLost values revoke — the network took the money back, so the credits go too. The call
        # is idempotent, so it is a no-op when dispute.opened already revoked (onOpen chose that).
        revoked = revokeDisputedGrants(ledger, case.customerId, payment.id, case.id) if payment else 0
        if policy.dispute.onLost == 'revoke_and_ban' and customer:
            customer.status = 'banned'; repo.customers.put(customer)
        return resolve(case, 'human', {outcome:'lost', revoked}, repo, clock, onCaseEvent)

    # 'won' (or unknown): the charge stands -> give every revoked credit back and lift the freeze.
    restored = restoreDisputedGrants(ledger, case.customerId, case.id) if outcome == 'won' else 0
    if customer and customer.status == 'frozen':
        customer.status = 'active'; repo.customers.put(customer)
    return resolve(case, 'human', {outcome: outcome or 'unknown', restored}, repo, clock, onCaseEvent)
```

## [EC:B18] evidence — chargeback evidence workflow

2026-09-09 audit gap #4 (2026-09-09 edge-case audit): `cs.dispute` freezes/revokes/
restores credits and escalates, but there was no way to collect and submit the evidence a card
network asks for, and no deadline. `policy.dispute.evidenceDueDays` (default 7, `packages/core`)
already existed. This section is P1 (audit item #4 — 보류) — implemented straight to spec/code, not
merely stubbed, since the shape was small enough to do in one pass.

Public surface: `evidence.checklist` · `evidence.collect` · `evidence.due` · `evidence.submit`.
Every item the kit cannot actually back with data comes back `available: false` with a `reason` —
never a fabricated value (measured, not assumed).

```pseudo
EvidenceItem = {key, label, required: bool, available: bool, value?, reason?}   # reason set iff !available
EvidenceRecord = {items: EvidenceItem[], dueAt: ISO, collectedAt: ISO, submittedAt?: ISO, providerRef?}

evidenceDueAt(case) -> Date:
    # case.openedAt + its OWN policySnapshot's evidenceDueDays (EC:I8 pattern) — a later policy
    # change never moves a deadline a case was already given.
    return case.openedAt + case.policySnapshot.dispute.evidenceDueDays days
```

### checklist({case, payment, sub?, repo, ledger, policy, clock}) -> EvidenceItem[]

Derives every item from what the kit already knows — no new storage, no invented data:

```pseudo
items = []
# 1 — payment record + provider refs
items.append(payment is not None
    ? {key:'payment_record', required:true, available:true, value:{id, provider, providerRef, amount, status, kind, occurredAt, subscriptionId}}
    : {key:'payment_record', required:true, available:false, reason:'no local payment record could be matched to this dispute'})

# 2/3 — ledger grant/consume history: for a credits business this IS the evidence — grant = goods
# delivered, consume = customer actually used them. Same bucket-attribution as B11/D9's revoke/restore.
if payment:
    all = ledger.entries(case.customerId, {pool:'paid'})
    grants = [e for e in all if e.kind=='grant' and e.reference.paymentId == payment.id]
    grantIds = {g.id for g in grants}
    consumes = [e for e in all if e.kind=='consume' and e.reference.grantId in grantIds]
else: grants, consumes = [], []
items.append(grants ? {key:'proof_of_delivery', required:true, available:true, value:[...]}
                     : {key:'proof_of_delivery', required:true, available:false, reason:...})
items.append(consumes ? {key:'proof_of_usage', required:true, available:true, value:[...]}
                       : {key:'proof_of_usage', required:true, available:false, reason:...})

# 4 — usage events, only when `sub` is given (usage-metered subscription)
scopedUsage = sub ? [e for e in repo.usageEvents.list({customerId: case.customerId})
                      if e.periodStart >= sub.currentPeriod.start] : []
items.append(scopedUsage ? {key:'usage_events', required:false, available:true, value:[...]}
                          : {key:'usage_events', required:false, available:false, reason:...})

# 5 — terms acceptance: the kit has NO such table. Always an honest gap, never invented.
items.append({key:'customer_acceptance', required:true, available:false,
              reason:'not recorded by the kit — attach it from your own signup/terms-acceptance log if you have one'})

# 6 — refund/communication history: attempts to resolve show good faith to the network
refunds = payment ? repo.refunds.list({paymentId: payment.id}) : []
items.append(refunds ? {key:'refund_communication', required:false, available:true, value:[...]}
                      : {key:'refund_communication', required:false, available:false, reason:'no refund requests found for this payment'})

# 7 — the cs_events trail: duck-typed against `repo.csEvents` (schema-postgres 0006 table, NOT part
# of the core Repo contract — same degrade pattern as reconcile.checkBalances' `creditBalances`).
# Falls back to the case's OWN lifecycle fields (openedAt/escalatedAt/resolvedAt/decision), which
# are always available since `case` is a required input — this item is never a hard "no data" gap.
trail = repo.csEvents?.list({caseId: case.id}) if duck-typed present else None
items.append({key:'case_trail', required:false, available:true,
              value: trail or {status, openedAt, escalatedAt, resolvedAt, decision}})
return items
```

### collect({case, payment, sub?, repo, ledger, policy, clock}) -> CsCase

```pseudo
items = checklist(...)
record = {items, dueAt: evidenceDueAt(case).isoformat(), collectedAt: clock.now().isoformat()}
case.decision = {...(case.decision or {}), evidence: record}
repo.csCases.put(case)
return case
idempotency: pure re-read + one repo.csCases.put — safe to call repeatedly, no ledger writes, each
             call refreshes the checklist against current data (e.g. a consume that happened since
             the last collect now shows up).
```

### due({repo, clock, notifier?}) -> DueCase[]

Meant to run off a cron.

```pseudo
out = []
for case in repo.csCases.list({kind:'dispute'}):
    if case.status not in ACTIVE_STATUSES: continue
    dueAt = evidenceDueAt(case)
    hoursRemaining = (dueAt - clock.now()) in hours
    incomplete = not case.decision?.evidence or any(i.required and not i.available for i in case.decision.evidence.items)
    if hoursRemaining <= 24 and incomplete:
        out.append({case, dueAt, hoursRemaining, incomplete})
        escalate(case, repo, clock, notifier, reason: f'evidence due in {hoursRemaining}h, checklist incomplete')
return out
idempotency: NOT idempotent in the strict sense — a case still inside the 24h window and still
             incomplete gets re-escalated (and re-notified) on every cron tick, by design: the
             point is a human keeps seeing it until either the deadline passes or evidence is
             completed. escalate() itself is safe to call repeatedly (I3).
```

### submit({case, payment, sub?, provider, repo, ledger, policy, clock, notifier?}) -> SubmitResult

```pseudo
# provider.submitDisputeEvidence is DUCK-TYPED — Stripe has one, Toss/PortOne do not — same pattern
# as refund.execute's CashReceiptCanceler (EC:K5).
record = case.decision?.evidence or collect(...).decision.evidence
if not callable(provider.submitDisputeEvidence):
    updated = escalate(case, repo, clock, notifier, reason:'evidence submission not supported by this provider — attach the checklist to the dashboard manually')
    return {submitted:false, reason:'provider_unsupported', portalUrl: provider.disputePortalUrl if str else None, case: updated}
if payment is None:
    updated = escalate(case, repo, clock, notifier, reason:'no payment record to submit evidence against')
    return {submitted:false, reason:'no_payment', case: updated}
try:
    result = provider.submitDisputeEvidence({paymentRef: payment.providerRef, caseId: case.id, evidence: record.items})
    case.decision = {...case.decision, evidence: {...record, submittedAt: clock.now().isoformat(), providerRef: result?.providerRef}}
    repo.csCases.put(case)
    return {submitted:true, providerRef: result?.providerRef, case}
except err:
    # NEVER pretend a submission happened.
    updated = escalate(case, repo, clock, notifier, reason: f'evidence submission failed: {err}')
    return {submitted:false, reason:'submit_failed', case: updated}
```

## [EC:I6] widget

```pseudo
signToken({customerId, ttlSeconds}, secret) -> str:
    header = base64url(json({"alg":"HS256","typ":"JWT"}))
    payload = base64url(json({"sub":customerId, "exp": now_epoch_s + ttlSeconds}))
    sig = base64url(HMAC_SHA256(secret, header + "." + payload))
    return header + "." + payload + "." + sig

verifyToken(token, secret) -> {customerId, exp}:
    header, payload, sig = token.split(".")
    expectedSig = base64url(HMAC_SHA256(secret, header + "." + payload))
    if not constant_time_eq(sig, expectedSig): raise invalid signature
    claims = json(base64url_decode(payload))
    if claims.exp <= now_epoch_s: raise expired
    return {customerId: claims.sub, exp: claims.exp}
```

No JWT library — implemented with `node:crypto` (`createHmac`) in TS and `hmac`/`hashlib` in Py, both
stdlib-only per ARCHITECTURE.md (no new dependencies).

## [EC:I4] churn.record

```pseudo
record({customerId, reason, text?, case?, repo?, clock?}):
    # CsCase already carries churnReason/churnText (core types.ts) — record onto the case when given.
    # A bare customerId-only variant (no case) has nowhere to persist under the current Repo contract
    # (no churn_reasons table) — returns the record but does not persist. Contract gap, see final report.
    if case is not None:
        case.churnReason = reason
        case.churnText = text
        if repo is not None: repo.csCases.put(case)
    return {customerId, reason, text, recordedAt: clock.now() if clock else None}
```

## [EC:I10] settlementReport — 월 정산 집계 (읽기 전용)

```pseudo
settlementReport({repo, ledger, from, to}):          # window [from, to); from >= to -> error
  payments: repo.payments where from <= occurredAt < to, grouped (currency, kind, status): count, sum amountMinor
  refunds:  repo.refunds where status = succeeded and from <= createdAt < to, grouped by currency
  net:      per currency, payments with status succeeded|partially_refunded minus refunds
  credits:  for each customer, ledger.entries(since from) with createdAt < to, grouped (kind, source): count, signed sum
  every list sorted by its group key; money is never summed across currencies; nothing is written
```

## [EC:I9] timeline

The paid CS product's job is answering "what happened to my payment / where are my credits" in one
place. Today that evidence is scattered across `payments`, `ledger_entries`, `webhook_events`,
`refunds`, `cs_cases`, `operations` (and `notifications` where the app's Repo happens to have one).
`timeline` is READ-ONLY reconstruction over the existing `Repo`/`LedgerStore` interfaces — no new
storage, no dependency on the audit-log layer built concurrently in core/providers/schema-postgres.

```pseudo
input: customerId?, paymentId?, subscriptionId?, since?, until?, repo, ledger, clock, limit? (default 500)
output: {events: TimelineEvent[], truncated: bool}
TimelineEvent = {at, kind, source, summary, refs: {paymentId? subscriptionId? caseId? refundId?
                 grantId? eventId?}, detail}

scoped = customerId or paymentId or subscriptionId is given

# ── payments ──────────────────────────────────────────────────────────────────────────────
payments = repo.payments.list(filter built from whichever of {customerId, id: paymentId,
            subscriptionId} were given) — [] if none were given
for p in payments (within [since, until]):
    kind = by p.status: pending/requires_action -> payment.created, succeeded -> payment.succeeded,
           failed -> payment.failed, refunded/partially_refunded -> payment.refunded,
           disputed -> payment.disputed
    emit {at: p.occurredAt, kind, source:'payments', refs:{paymentId, subscriptionId},
          detail:{status, amount, failureCode, failureUserMessage}}   # normalized failure surfaced

# ── customer resolution ──────────────────────────────────────────────────────────────────
customerIds = {customerId} ∪ {p.customerId for p in payments}
             ∪ {sub.customerId for sub in repo.subscriptions.list({id: subscriptionId})} if subscriptionId given
# ledger_entries and cs_cases (paymentId-referenceId path aside) both need a resolved customerId —
# LedgerStore.entries() takes customerId as a REQUIRED positional arg, it cannot be queried by
# paymentId across all customers directly.

# ── ledger_entries (EC:B14-respecting running balance) ───────────────────────────────────
for cid in customerIds:
    all = ledger.entries(cid)                       # already in append/chronological order
    balances = runningBalances(all)                  # see below — NOT ledger.balance() per entry
    for i, e in enumerate(all):
        if paymentId and e.reference.paymentId != paymentId: continue
        if subscriptionId and e.reference.subscriptionId != subscriptionId: continue
        kind = grant->credits.granted, consume->credits.consumed, revoke->credits.revoked,
               expire->credits.expired, hold->credits.held, release->credits.released,
               adjust->credits.adjusted
        emit {at: e.createdAt, kind, source:'ledger_entries',
              refs:{paymentId: e.reference.paymentId, subscriptionId: e.reference.subscriptionId,
                    caseId: e.reference.caseId, refundId: e.reference.refundId,
                    grantId: e.id if e.kind=='grant' else e.reference.grantId},
              detail:{amount: e.amount, pool, source, balanceAfter: balances[i], unitPriceMinor, currency}}

runningBalances(entries):     # mirrors InMemoryLedger buildBuckets+unbucketedTotal+B14 expiry rule,
                               # computed INCREMENTALLY (NOT by calling ledger.balance(id, pool, e.createdAt)
                               # per entry — balance() has no creation-time cutoff, only an expiry
                               # cutoff, so it would still include every LATER entry already in the store)
    buckets = {}; unbucketed = 0; out = []
    for e in entries (in order):
        if e.kind == 'grant': buckets[e.id] = {expiresAt: e.expiresAt, remaining: e.amount}
        else:
            b = buckets.get(e.reference.grantId)
            if b: b.remaining += e.amount
            else: unbucketed += e.amount
        total = unbucketed + sum(b.remaining for b in buckets.values()
                                  if b.expiresAt is None or b.expiresAt > e.createdAt)   # EC:B14
        out.append(total)
    return out

# ── webhook_events ────────────────────────────────────────────────────────────────────────
# WebhookEventRecord has NO customerId/paymentId/subscriptionId column (contract gap — see final
# report). A SCOPED query cannot be correlated to it without a fragile rawBody text heuristic, so
# webhook rows are only folded in for a fully UNSCOPED (global) call.
if not scoped:
    for w in repo.webhookEvents.list():
        kind = received->webhook.received, processed->webhook.processed, failed->webhook.failed
               (skip 'processing'/'ignored' — not part of the vocabulary)
        at = w.receivedAt if w.status=='received' else (w.processedAt or w.receivedAt)
        emit {at, kind, source:'webhook_events', refs:{eventId: w.id},
              detail:{provider, type, status, error, attempts}}

# ── refunds ───────────────────────────────────────────────────────────────────────────────
refunds = repo.refunds.list({paymentId}) if paymentId else (per-customerId union) else repo.refunds.list()
for r in refunds:
    kind = pending->refund.requested, succeeded->refund.succeeded, failed->refund.failed
    emit {at: r.createdAt, kind, source:'refunds', refs:{paymentId: r.paymentId, refundId: r.id},
          detail:{amount, status, ruleId, creditsRevoked, reason}}

# ── cs_cases ──────────────────────────────────────────────────────────────────────────────
cases = repo.csCases.list({referenceId: paymentId}) if paymentId else (per-customerId union) else repo.csCases.list()
for c in cases:
    emit {at: c.openedAt, kind:'case.opened', source:'cs_cases', refs:{caseId: c.id}}
    if c.status in {'needs_human', 'resolved_human'}:      # CsCase has no escalatedAt column —
        emit {at: c.openedAt, kind:'case.escalated', ...}   # approximated at openedAt (contract gap,
                                                              # see final report), 'resolved_human'
                                                              # implies it passed through needs_human
    if c.resolvedAt:
        if c.status == 'rejected': emit {at: c.resolvedAt, kind:'case.rejected', ...}
        elif c.status in {'resolved_auto','resolved_human'}: emit {at: c.resolvedAt, kind:'case.resolved', ...}

# ── operations ────────────────────────────────────────────────────────────────────────────
# Operation has NO attempts/replay counter (unlike WebhookEventRecord.attempts) — runIdempotent's
# replay branch returns the cached result WITHOUT touching the row, so a row replayed 5 times is
# byte-identical to one run once (contract gap — see final report). We surface every completed
# idempotency-guarded operation correlated to the query (substring match of a known id against
# `key`, per the EC:J5 key convention) as `operation.replayed` — it proves "repeat submissions were
# safely deduped" (the CS-relevant fact), even though the true replay COUNT is not reconstructable.
relevantIds = {paymentId, subscriptionId} ∪ {p.id for p in payments} ∪ {c.id for c in cases}
for op in repo.operations.list():
    if op.status != 'done': continue
    if scoped and not any(id in op.key for id in relevantIds): continue
    emit {at: op.completedAt or op.createdAt, kind:'operation.replayed', source:'operations',
          refs:{eventId: op.key}, detail:{key: op.key, kind: op.kind}}

# ── notifications (duck-typed) ───────────────────────────────────────────────────────────
if hasattr(repo, 'notifications') and hasattr(repo.notifications, 'list'):
    for n in repo.notifications.list(): emit {...}          # core Repo has none today — always skipped

events.sort(by=at, stable=True)     # equal-timestamp ties resolve by fold push order (documented
                                     # above): payments, ledger_entries, webhook_events, refunds,
                                     # cs_cases (opened before escalated before resolved/rejected
                                     # per case), operations, notifications
limit = limit or 500
truncated = len(events) > limit
return {events: events[-limit:] if truncated else events, truncated}   # NEWEST-truncated: the
                                                                        # oldest events are dropped
```

**정렬 (2026-09-09 실측으로 추가)**: 같은 시각에 여러 사건이 생긴다(분쟁 개시 한 번에 케이스 생성 +
크레딧 회수 + 에스컬레이션). 시각만으로 정렬하면 어느 소스를 먼저 접었는지에 순서가 좌우돼 **같은
질의가 두 번 다르게 읽힌다** — CS 화면에서는 못 쓴다. 동시각은 인과 순위로 깬다:

```pseudo
KIND_RANK = payment.* 1 · webhook.* 2 · case.opened 3 · case.escalated 4 · credits.* 5
            · refund.* 6 · case.resolved|rejected 7 · operation.replayed 8 · notification.sent 9
sort by (at, KIND_RANK[kind])      # 정렬은 stable 이므로 동률은 접은 순서 유지 = 결정적
```

이 순위는 코드가 실제로 하는 순서를 따른다. 예: 분쟁 승소는 **크레딧을 복원한 뒤 케이스를 닫으므로**
`credits.granted` 가 `case.resolved` 보다 앞선다.


Never throws on a missing/duck-typed table — degrades to fewer event kinds (`safeList` swallows any
exception from a table call and treats it as `[]`).

**`until` is NOT defaulted to `clock.now()`.** `InMemoryLedger.append()`/`InMemoryLedger.append()`
(py: same) stamp `createdAt`/`created_at` with the REAL wall clock, ignoring the injected `Clock`
entirely (a pre-existing `packages/core` reference-implementation characteristic, not something
this package can fix). Defaulting `until` to a `clock.now()` that is a `FixedClock` pinned to a past
test date would silently filter out every real-time-stamped ledger entry. `until` stays unbounded
unless the caller passes one explicitly.

### explain(events) -> string[]

```pseudo
for e in events:
    payment.*:   "payment {refs.paymentId} {detail.status} ({formatMoney(detail.amount)})"
    credits.*:   "{abs(detail.amount)} credits {granted|consumed|revoked|expired|held|released|adjusted}"
                 # tracks detail.balanceAfter as lastBalance
    refund.*:    "refund {refs.refundId} for {formatMoney(detail.amount)} ({detail.ruleId})"
                 + ", {detail.creditsRevoked} credits revoked" if succeeded and >0
                 + " — failed" if failed
    webhook.*:   e.summary
    case.opened/escalated/resolved/rejected: "case {refs.caseId} {opened|escalated|resolved|rejected}"
    operation.replayed: "operation {detail.kind} replay-safe"
    notification.sent: e.summary
if lastBalance is not None: append "balance now {lastBalance}"
```

`formatMoney` — currency-aware, using `ZERO_DECIMAL_CURRENCIES` from `packages/core` money helpers
(KRW/JPY have no minor-unit division; everything else divides `amountMinor` by 100). A small symbol
table (`$ ₩ ¥ € £`) is used when known, else `"{amount} {CURRENCY}"`.

---

## [EC:H5] exportCustomer — GDPR / 개인정보보호법 데이터 이동권

2026-09-09 audit gap #10 (2026-09-09 edge-case audit): H2 covers deletion vs 전자상거래법
5-year retention (anonymize `customers` PII, keep the ledger) but there was no export. This section
adds only the export half — **it never deletes anything**, so it is always safe to run regardless of
whatever policy an app has chosen for H2. Deletion stays H2's harder, separate decision.

```pseudo
input: customerId, repo, ledger, clock, redact: bool = true
# `redact` defaults true — every field passes through packages/core's `redact()` (EC:L2) so a card
# number / 주민번호 / API secret never leaves the kit in the clear. Pass `redact:false` ONLY when
# legally answering a subject access request that requires the raw values.

customer      = repo.customers.get(customerId)
subscriptions = repo.subscriptions.list({customerId})
payments      = repo.payments.list({customerId})
ledgerEntries = ledger.entries(customerId)              # unbounded — the FULL history, not a page
usageEvents   = repo.usageEvents.list({customerId})
refunds       = repo.refunds.list({customerId})
csCases       = repo.csCases.list({customerId})
tl            = timeline({customerId, repo, ledger, clock})   # EC:I9, reused as-is — no re-derivation

raw = {schemaVersion: 1, generatedAt: clock.now(), customerId, redacted: redact,
       customer, subscriptions, payments, ledgerEntries, usageEvents, refunds, csCases, timeline: tl}
shaped = redact(raw) if redact else raw
return toJsonSafe(shaped)     # recursively Date/datetime -> ISO string, so the result round-trips
                               # through JSON.stringify/json.dumps with no further conversion needed
```

Runs purely against the `Repo`/`LedgerStore` interfaces — no schema assumptions beyond the core
contract, so it works identically against `InMemoryRepo`/`InMemoryLedger` and a Postgres-backed
implementation. `redact()` (TS) operates on live objects and preserves `Date` instances; Python's
`redact()` only recurses into `dict`/`list`/`str`/`datetime` (not dataclass instances), so the
Python implementation converts every row to a plain dict (`dataclasses.asdict`, which already walks
the full object graph including dataclasses nested inside plain `dict`/`list` values) BEFORE calling
`redact()`, then converts every `datetime` leaf to an ISO string in a final pass.

---

## [EC:L5] regrant / refundAssist / dispute / timeline — correlationId propagation

`regrant`, `refundAssist` and `dispute` each accept an optional `correlationId?: string` on their
input, for callers that did NOT already go through `webhook.process`'s own ledger-wrapping
(`packages/webhook/{ts,py}/src/correlation.*`). `timeline` accepts an optional `correlationId?`
query filter and surfaces `correlationId` on `TimelineEvent.refs` when the underlying ledger row
has one.

```pseudo
# regrant — the one ledger.append() (auto-mode grant) merges it into `reference`, additive since
# regrant always builds `reference: {caseId}` fresh:
reference: {caseId: case.id, ...(correlationId ? {correlationId} : {})}

# refundAssist — deliberately does NOT import refund.execute (decoupled, injected functions — see
# RefundExecuteFn). correlationId is passed straight through to the injected refundExecute call
# unchanged; refundAssist itself never touches a ledger entry's reference directly.
refund = refundExecute({decision, provider, ledger, repo, clock, ids, correlationId, cs: ...})

# dispute — revokeDisputedGrants/restoreDisputedGrants (private helpers) both take correlationId
# and merge it into every reference they build, so BOTH the dispute.opened revoke and a later
# D9-won restore carry the SAME id when the caller passes the same correlationId to both calls
# (e.g. the webhook decorator's per-delivery id, or an app re-supplying the same id across the two
# dispute.opened / dispute.closed webhook deliveries that share one correlationId only if the
# caller chooses to correlate them that way — dispute itself does not persist or infer it).
reference: {paymentId, caseId, grantId?, ...(correlationId ? {correlationId} : {})}

# timeline — filters the ledger_entries source only (payments/webhook_events/refunds/cs_cases/
# operations rows carry no correlationId of their own):
for e in ledgerEntriesForScope:
    if opts.correlationId and e.reference.correlationId != opts.correlationId: continue
    ...
    refs.correlationId = e.reference.correlationId
```

`timeline({correlationId})` without any of `customerId`/`paymentId`/`subscriptionId` returns an
empty ledger_entries slice, honestly — `LedgerStore.entries()` is always customer-scoped (no global
query), so correlationId can only narrow an already-resolved customer/payment/subscription scope,
not stand in for one. This is the "show me everything that happened in this one delivery, for the
customer I'm already looking at" query a support agent actually runs, not an unscoped global search.

## Step 1 support services — identifiers and immutable sale evidence

Public services (TS / Python snake_case counterparts):

- `startCheckout(StartCheckoutInput)` captures customer/provider reference, plan/price, credits and policy
  before calling the provider. Reserved `checkout.entitlement` Operations hold the immutable intent,
  provider result and checkout-ID lookup. `requestId` replays the same result; concurrent claims do not
  create a second checkout. Unknown creation outcomes remain recorded and require reconciliation.
- `registerCompletedCheckout({customerId, checkoutId, paymentRef, subscriptionRef?, ...deps})` verifies
  successful provider payment, customer ownership, amount/currency and the actual checkout relation.
  PortOne matches payment ID; Toss matches orderId; Stripe matches propagated checkoutEntitlementKey;
  Polar matches that metadata or checkout_id. Matching only price/customer is insufficient.
  The service persists local payment identity plus immutable `purchase.entitlement`, keyed by payment ID.
  Native subscription completion also requires provider-correlated subscription identity and period.
  Providers lacking that evidence remain unsupported for automatic subscription registration.
- `applyPurchasedGrant({customerId,paymentId,grants,...deps})` performs initial fulfillment using only
  the captured plan/policy/period and purchase timestamp. It calls the existing credit primitives,
  preserving expiry, negative offset, payment references and original topup/subscription grant keys.
- `recoverMissingGrant(...)` verifies the local customer/payment and provider facts, then uses the same
  captured entitlement. `auto` executes, `manual_approve` remains needs_human, `off` rejects. Missing or
  inconsistent snapshots remain needs_human; current catalog price matching never invents historical
  credits. The customer cannot submit a grant amount, plan replacement or approvedBy.
- `recoverMissingGrants({customerId?,since?,grants,...deps})` scans persisted local payments. Provider-only
  payments lacking a sale record require reconciliation and are not automatically assigned an entitlement.
- `requestRefund({customerId,paymentId,requestId?,requestedAmount?,...deps})` verifies persisted ownership
  and live provider facts, loads local subscription context, creates the case policy snapshot, evaluates
  rules and calls refundAssist. No customer-supplied Payment/Subscription/RefundDecision/approval is accepted.
- `finishRefundCases({repo,clock,reporter?,...})` reads the stored refund linked to a pending original case.
  Confirmed success resolves that same case once; pending never resolves; failure remains actionable.
  Generated webhook processing and maintenance invoke this service after refund reconciliation.

Support case creation is atomically keyed by customer, payment, kind and refund request identity.
Recovery completion has its own atomic operation so simultaneous or repeated requests create one grant,
case resolution and billable report. Missing-evidence active cases can be re-evaluated after registration;
completed recovery returns its existing case. Refund request replay reads the latest stored case, including
settlement after the initial pending response. Low-level primitives remain available for trusted integrations.

Reserved checkout/purchase entitlement operations are business evidence and must not be removed by routine
short-lived operation retention. This is distinct from the ordinary retry retention window.
