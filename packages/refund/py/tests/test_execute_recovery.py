"""EC:D12 D15 J1 — keep unknown requests pending and retry local settlement only."""

import asyncio
from unittest.mock import AsyncMock

import pytest
from boilpayment_refund import EvaluateInput, ExecuteInput, evaluate, execute
from test_refund import FakeProvider, do_grant, make_env, make_topup


async def setup():
    clock, ids, ledger, repo, policy = make_env()
    payment = await make_topup(repo, clock, "pay_1", 1000)
    await do_grant(ledger, payment.id, 100, 10)
    provider = FakeProvider()
    provider.refund = AsyncMock(wraps=provider.refund)
    decision = await evaluate(EvaluateInput(payment=payment, policy=policy, ledger=ledger, repo=repo, clock=clock))
    return ExecuteInput(decision=decision, provider=provider, ledger=ledger, repo=repo, clock=clock, ids=ids)


def test_timeout_remains_pending_without_second_provider_request():
    async def run():
        input = await setup()
        input.provider.refund.side_effect = TimeoutError("request timed out after submission")
        first = await execute(input)
        assert first.status == "pending"
        assert first.failure.code == "refund_outcome_unknown"
        assert first.failure.retryable is False
        assert (await input.ledger.balance("cust_1", "paid", input.clock.now())).available == 0
        assert await input.ledger.entries("cust_1", kind="release") == []
        assert await execute(input) == first
        assert input.provider.refund.await_count == 1
    asyncio.run(run())


@pytest.mark.parametrize("failure", ["revoke", "payment", "refund"])
def test_local_failure_resumes_after_provider_success_without_second_refund(failure, monkeypatch):
    async def run():
        input = await setup()
        error = RuntimeError("local storage unavailable")
        if failure == "revoke":
            original = input.ledger.append
            async def append(entry):
                if entry.kind == "revoke":
                    raise error
                return await original(entry)
            monkeypatch.setattr(input.ledger, "append", append)
        elif failure == "payment":
            monkeypatch.setattr(input.repo.payments, "put", AsyncMock(side_effect=error))
        else:
            original = input.repo.refunds.put
            async def put(row):
                if row.status == "succeeded":
                    raise error
                return await original(row)
            monkeypatch.setattr(input.repo.refunds, "put", put)
        with pytest.raises(RuntimeError, match="local storage unavailable"):
            await execute(input)
        assert (await input.repo.refunds.list())[0].status == "pending"
        monkeypatch.undo()
        result = await execute(input)
        assert result.status == "succeeded"
        assert input.provider.refund.await_count == 1
        assert (await input.ledger.balance("cust_1", "paid", input.clock.now())).available == 0
        assert len(await input.repo.refunds.list()) == 1
    asyncio.run(run())


def test_lost_provider_checkpoint_does_not_allow_another_provider_request(monkeypatch):
    async def run():
        input = await setup()
        original = input.repo.operations.put
        async def put(operation):
            if operation.kind == "refund.provider" and operation.status == "done":
                raise RuntimeError("checkpoint unavailable")
            return await original(operation)
        monkeypatch.setattr(input.repo.operations, "put", put)
        with pytest.raises(RuntimeError, match="checkpoint unavailable"):
            await execute(input)
        monkeypatch.undo()
        assert (await execute(input)).status == "pending"
        assert input.provider.refund.await_count == 1
        assert (await input.ledger.balance("cust_1", "paid", input.clock.now())).available == 0
    asyncio.run(run())


def test_submitted_checkpoint_cannot_overwrite_reconciled_refund(monkeypatch):
    async def run():
        from dataclasses import replace
        input = await setup()
        original = input.repo.operations.put
        async def put(operation):
            if operation.kind == "refund.provider" and operation.status == "done":
                raise RuntimeError("checkpoint unavailable")
            return await original(operation)
        monkeypatch.setattr(input.repo.operations, "put", put)
        with pytest.raises(RuntimeError, match="checkpoint unavailable"):
            await execute(input)
        monkeypatch.undo()
        pending = (await input.repo.refunds.list())[0]
        reconciled = replace(pending, status="failed", failure=None)
        await input.repo.refunds.put(reconciled)
        assert await execute(input) == reconciled
        assert input.provider.refund.await_count == 1
    asyncio.run(run())


@pytest.mark.parametrize("status", ["pending", "succeeded"])
def test_preserved_partial_refund_checkpoint_survives_outer_retention(status):
    async def run():
        from dataclasses import replace

        from boilpayment_core import InMemoryRepo, Money, Refund
        input = await setup()
        input.decision = replace(input.decision, amount=Money(amount_minor=400, currency="USD"), credits_to_revoke=40)
        input.provider.refund.return_value = Refund(
            id="provider_refund", payment_id="pay_1", customer_id="cust_1", amount=input.decision.amount,
            status=status, provider_ref="provider_refund", credits_revoked=0, rule_id="D1",
            reason=None, failure=None, created_at=input.clock.now(),
        )
        first = await execute(input)
        retained = [row for row in await input.repo.operations.list() if row.kind == "refund.provider"]
        assert len(retained) == 1
        input.repo.operations = InMemoryRepo().operations
        for row in retained:
            await input.repo.operations.put(row)
        input.clock.advance(8 * 86_400_000)
        assert await execute(input) == first
        assert input.provider.refund.await_count == 1
        assert len(await input.repo.refunds.list()) == 1
        assert (await input.ledger.balance("cust_1", "paid", input.clock.now())).available == 60
    asyncio.run(run())
