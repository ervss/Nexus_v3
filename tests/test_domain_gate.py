import asyncio

from app.ntc.domain_gate import DomainGate


def test_single_failure_does_not_open_domain_circuit():
    """One slow Bunkr page must not time out every queued album item."""

    async def run():
        gate = DomainGate("bunkr.cr", fail_threshold=3, burst=3)

        await gate.acquire(deadline=0.1)
        await gate.release(ok=False)

        assert gate._open_until == 0.0

        # This is the request that previously sat behind a 20-second circuit
        # cooldown and failed with "NTC domain gate timeout".
        await gate.acquire(deadline=0.1)
        await gate.release(ok=True)

    asyncio.run(run())


def test_domain_circuit_opens_after_configured_consecutive_failures():
    async def run():
        gate = DomainGate("bunkr.cr", fail_threshold=3, burst=4)

        for _ in range(3):
            await gate.acquire(deadline=0.1)
            await gate.release(ok=False)

        assert gate._open_until > gate._now()

    asyncio.run(run())
