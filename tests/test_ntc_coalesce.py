import asyncio
import gc

import pytest

from app.ntc.coalesce import Coalescer


def test_coalescer_timeout_does_not_leave_unretrieved_future(capsys):
    c = Coalescer()

    async def boom():
        raise TimeoutError("NTC domain gate timeout for camwhores.tv")

    async def run():
        with pytest.raises(TimeoutError, match="camwhores"):
            await c.do("same-key", boom)
        with pytest.raises(TimeoutError, match="camwhores"):
            await c.do("same-key", boom)

    asyncio.run(run())
    gc.collect()
    err = capsys.readouterr().err
    assert "Future exception was never retrieved" not in err


def test_coalescer_waiter_gets_same_timeout():
    c = Coalescer()
    started = asyncio.Event()

    async def boom():
        started.set()
        await asyncio.sleep(0.05)
        raise TimeoutError("NTC domain gate timeout for camwhores.tv")

    async def run():
        first = asyncio.create_task(c.do("k", boom))
        await started.wait()
        second = asyncio.create_task(c.do("k", boom))
        results = await asyncio.gather(first, second, return_exceptions=True)
        assert all(isinstance(item, TimeoutError) for item in results)

    asyncio.run(run())
