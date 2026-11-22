"""A bounded, metadata-only live pass over joined Telegram chats."""
import asyncio
import logging

from telethon.errors import FloodWaitError
from telethon.tl.types import InputMessagesFilterVideo

from .database import SessionLocal
from .telegram_index import telegram_library_identities, upsert_telegram_media_batch
from .telegram_service import client, _get_messages, _row
from .telegram_stream import public_chat_id

logger = logging.getLogger(__name__)
SCAN_PER_CHAT = 20
NEW_PER_CHAT = 5
MAX_RESULTS = 2000


async def stream_new_videos():
    """Read each joined chat once and passively enrich the metadata index."""
    try:
        connection = await client()
        dialogs = [d async for d in connection.iter_dialogs() if d.is_channel or d.is_group]
        names = {str(d.entity.username).lower(): public_chat_id(int(d.id))
                 for d in dialogs if getattr(d.entity, 'username', None)}
        total, completed, found, errors = len(dialogs), 0, 0, 0
        yield {'status': 'start', 'total': total, 'scan_per_chat': SCAN_PER_CHAT, 'per_chat': NEW_PER_CHAT}
        for dialog in dialogs:
            try:
                # Shared semaphore and cooldown protect the account and other Nexus jobs.
                messages = await asyncio.wait_for(_get_messages(connection, dialog.entity,
                    limit=SCAN_PER_CHAT, filter=InputMessagesFilterVideo, _background=True), timeout=45)
                all_rows = []
                for message in messages:
                    row = _row(message, dialog.entity, str(dialog.id))
                    if row:
                        all_rows.append(row)
                with SessionLocal() as db:
                    if all_rows and hasattr(db, "execute"):
                        try:
                            upsert_telegram_media_batch(db, all_rows)
                        except Exception:
                            logger.debug("Live new index upsert skipped", exc_info=True)
                    library = telegram_library_identities(db, names)
                new = []
                for row in all_rows:
                    if f"{public_chat_id(int(row['chat_id']))}:{row['message_id']}" not in library:
                        new.append(row)
                        if len(new) >= min(NEW_PER_CHAT, MAX_RESULTS - found):
                            break
                found += len(new)
                completed += 1
                yield {'status': 'progress', 'completed': completed, 'total': total, 'found': found,
                       'errors': errors, 'channel': str(dialog.title or dialog.id), 'videos': new}
                if found >= MAX_RESULTS:
                    yield {'status': 'done', 'completed': completed, 'total': total, 'found': found,
                           'errors': errors, 'limited': True}
                    return
            except FloodWaitError as exc:
                yield {'status': 'flood_wait', 'seconds': int(exc.seconds), 'completed': completed,
                       'total': total, 'found': found, 'errors': errors}
                return
            except Exception:
                logger.exception('Live new video scan failed for a chat')
                completed += 1
                errors += 1
                yield {'status': 'progress', 'completed': completed, 'total': total, 'found': found,
                       'errors': errors, 'channel': str(dialog.title or dialog.id), 'videos': []}
        yield {'status': 'done', 'completed': completed, 'total': total, 'found': found, 'errors': errors, 'limited': False}
    except PermissionError:
        yield {'status': 'error', 'error': 'Telegram účet nie je pripojený. Prihlás sa v nastaveniach Telegramu.'}
    except FloodWaitError as exc:
        yield {'status': 'flood_wait', 'seconds': int(exc.seconds), 'completed': 0, 'total': 0, 'found': 0, 'errors': 0}
    except Exception:
        logger.exception('Live new video scan failed')
        yield {'status': 'error', 'error': 'Nepodarilo sa načítať Telegram skupiny. Skontroluj pripojenie a skús znova.'}
