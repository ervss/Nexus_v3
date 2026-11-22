"""Bounded task fan-out with deterministic cancellation and streaming results."""
import asyncio


async def map_unordered(items, operation, *, workers=5):
    iterator = iter(items)
    output = asyncio.Queue(maxsize=workers)
    sentinel = object()

    async def worker():
        try:
            for item in iterator:
                try:
                    await output.put((await operation(item), None))
                except Exception as exc:
                    await output.put((None, exc))
        finally:
            # On cancellation the consumer is also closing; do not block on put.
            if not asyncio.current_task().cancelling():
                await output.put((sentinel, None))

    tasks = [asyncio.create_task(worker()) for _ in range(workers)]
    finished = 0
    try:
        while finished < workers:
            result, error = await output.get()
            if error:
                raise error
            if result is sentinel:
                finished += 1
            else:
                yield result
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
