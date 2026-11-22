import asyncio

from app.routers import link_tester


def test_disconnect_cancels_pending_metadata():
    async def scenario():
        cancelled = asyncio.Event()

        async def pending():
            try:
                await asyncio.sleep(30)
            finally:
                cancelled.set()

        class Disconnected:
            async def is_disconnected(self):
                return True

        try:
            await link_tester._gather_meta_until_disconnect([pending()], Disconnected())
        except link_tester.HTTPException as exc:
            assert exc.status_code == 499
        else:
            raise AssertionError('Expected cancellation')
        assert cancelled.is_set()

    asyncio.run(scenario())


def test_connected_metadata_returns_results():
    async def scenario():
        class Connected:
            async def is_disconnected(self):
                return False

        async def fetch():
            return {'ok': True}

        result = await link_tester._gather_meta_until_disconnect([fetch()], Connected())
        assert result == [{'ok': True}]

    asyncio.run(scenario())


def test_cache_hit_finishes_when_disconnect_check_consumes_cancellation():
    async def scenario():
        checking = asyncio.Event()

        class Connected:
            async def is_disconnected(self):
                checking.set()
                try:
                    await asyncio.sleep(30)
                except asyncio.CancelledError:
                    return False

        async def cached():
            await checking.wait()
            return {'ok': True, 'cached': True}

        result = await asyncio.wait_for(
            link_tester._gather_meta_until_disconnect([cached()], Connected()), 1)
        assert result == [{'ok': True, 'cached': True}]

    asyncio.run(scenario())
