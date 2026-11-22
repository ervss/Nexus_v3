
from telethon import TelegramClient
from telethon.sessions import SQLiteSession
from telethon.sessions.sqlite import CURRENT_VERSION
import asyncio
import inspect
import logging
import os
import sqlite3
import time
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

_SESSION_COLUMNS = ("dc_id", "server_address", "port", "auth_key", "takeout_id")
_EVENT_LOOP_WRITE_BUSY_MS = 150
_DEFAULT_BUSY_MS = 30000


def _on_running_event_loop() -> bool:
    """Return True when called directly on the thread of a running asyncio loop."""
    try:
        asyncio.get_running_loop()
        return True
    except RuntimeError:
        return False


def _is_locked_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return "locked" in msg or "busy" in msg


class ResilientSQLiteSession(SQLiteSession):
    """SQLiteSession with WAL mode, immediate commits, and non-blocking event-loop writes."""

    def __init__(self, session_id=None, store_tmp_auth_key_on_disk: bool = False):
        self._persisted_session_row = None
        if "store_tmp_auth_key_on_disk" in inspect.signature(SQLiteSession.__init__).parameters:
            super().__init__(session_id, store_tmp_auth_key_on_disk=store_tmp_auth_key_on_disk)
        else:
            super().__init__(session_id)
        self._persisted_session_row = self._session_row_tuple()

    def _session_row_tuple(self):
        tmp_key = getattr(self, "_tmp_auth_key", None)
        store_tmp = getattr(self, "store_tmp_auth_key_on_disk", False)
        return (
            self._dc_id,
            self._server_address,
            self._port,
            self._auth_key.key if self._auth_key else b"",
            self._takeout_id,
            tmp_key.key if (store_tmp and tmp_key) else b"",
        )

    def _cursor(self):
        if self._conn is None:
            connect_timeout = (_EVENT_LOOP_WRITE_BUSY_MS / 1000.0) if _on_running_event_loop() else (_DEFAULT_BUSY_MS / 1000.0)
            self._conn = sqlite3.connect(
                self.filename,
                timeout=connect_timeout,
                check_same_thread=False,
            )
            try:
                self._conn.execute(f"PRAGMA busy_timeout={_DEFAULT_BUSY_MS}")
                mode_row = self._conn.execute("PRAGMA journal_mode").fetchone()
                if not mode_row or str(mode_row[0]).lower() != "wal":
                    self._conn.execute("PRAGMA journal_mode=WAL")
            except sqlite3.OperationalError:
                pass
        return self._conn.cursor()

    def _run_write(self, op_name: str, fn):
        """Execute a session write without blocking an active asyncio event loop for 30s."""
        on_loop = _on_running_event_loop()
        if on_loop and self._conn is not None:
            try:
                self._conn.execute(f"PRAGMA busy_timeout={_EVENT_LOOP_WRITE_BUSY_MS}")
            except sqlite3.OperationalError:
                pass
        try:
            result = fn()
            if self._conn is not None and self._conn.in_transaction:
                self._conn.commit()
            return result
        except sqlite3.OperationalError as exc:
            if self._conn is not None:
                try:
                    self._conn.rollback()
                except sqlite3.Error:
                    pass
            if _is_locked_error(exc) and on_loop:
                logger.warning("Skipping Telethon session write (%s): %s", op_name, exc)
                return None
            raise
        finally:
            if on_loop and self._conn is not None:
                try:
                    self._conn.execute(f"PRAGMA busy_timeout={_DEFAULT_BUSY_MS}")
                except sqlite3.Error:
                    pass

    def _update_session_table(self):
        current_row = self._session_row_tuple()
        if self._persisted_session_row is not None and current_row == self._persisted_session_row:
            return
        wrote = False

        def _write():
            nonlocal wrote
            super(ResilientSQLiteSession, self)._update_session_table()
            wrote = True

        self._run_write("update_session_table", _write)
        if wrote:
            self._persisted_session_row = current_row

    def set_update_state(self, entity_id, state):
        self._run_write(
            "set_update_state",
            lambda: super(ResilientSQLiteSession, self).set_update_state(entity_id, state),
        )

    def process_entities(self, tlo):
        if not self.save_entities:
            return
        self._run_write(
            "process_entities",
            lambda: super(ResilientSQLiteSession, self).process_entities(tlo),
        )

    def cache_file(self, md5_digest, file_size, instance):
        self._run_write(
            "cache_file",
            lambda: super(ResilientSQLiteSession, self).cache_file(md5_digest, file_size, instance),
        )

    def save(self):
        if self._conn is not None and self._conn.in_transaction:
            self._run_write("save", lambda: self._conn.commit())

    def get_entity_rows_by_username(self, username):
        if not _on_running_event_loop():
            result = super(ResilientSQLiteSession, self).get_entity_rows_by_username(username)
            if self._conn is not None and self._conn.in_transaction:
                self._conn.commit()
            return result
        try:
            self._conn and self._conn.execute(f"PRAGMA busy_timeout={_EVENT_LOOP_WRITE_BUSY_MS}")
        except sqlite3.Error:
            pass
        try:
            result = super(ResilientSQLiteSession, self).get_entity_rows_by_username(username)
            if self._conn is not None and self._conn.in_transaction:
                self._conn.commit()
            return result
        except sqlite3.OperationalError as exc:
            if self._conn is not None:
                try:
                    self._conn.rollback()
                except sqlite3.Error:
                    pass
            if _is_locked_error(exc):
                logger.warning("Skipping Telethon username eviction write: %s", exc)
                return None
            raise
        finally:
            if self._conn is not None:
                try:
                    self._conn.execute(f"PRAGMA busy_timeout={_DEFAULT_BUSY_MS}")
                except sqlite3.Error:
                    pass


def align_session_schema(session_path: str) -> None:
    """Make a newer Telethon session readable by this install.

    Telethon 1.42 stores five session columns (schema 7). A newer Telethon
    writes schema 8 and adds tmp_auth_key. ``SELECT *`` then raises
    ``ValueError: too many values to unpack (expected 5)`` before connect.
    """
    if CURRENT_VERSION != 7 or not session_path or not os.path.exists(session_path):
        return
    connection = sqlite3.connect(session_path, timeout=30)
    try:
        columns = [row[1] for row in connection.execute("pragma table_info(sessions)")]
        if columns == list(_SESSION_COLUMNS):
            return
        if columns[: len(_SESSION_COLUMNS)] != list(_SESSION_COLUMNS):
            return
        version_row = connection.execute("select version from version").fetchone()
        connection.execute("BEGIN")
        connection.execute(
            """
            CREATE TABLE sessions_v7 (
                dc_id integer primary key,
                server_address text,
                port integer,
                auth_key blob,
                takeout_id integer
            )
            """
        )
        connection.execute(
            """
            INSERT INTO sessions_v7 (dc_id, server_address, port, auth_key, takeout_id)
            SELECT dc_id, server_address, port, auth_key, takeout_id FROM sessions
            """
        )
        connection.execute("DROP TABLE sessions")
        connection.execute("ALTER TABLE sessions_v7 RENAME TO sessions")
        if version_row and int(version_row[0]) > CURRENT_VERSION:
            connection.execute("DELETE FROM version")
            connection.execute("INSERT INTO version VALUES (?)", (CURRENT_VERSION,))
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()

def _session_has_auth_key(session_file: str = "telegram_session.session") -> bool:
    if not os.path.exists(session_file):
        return False
    try:
        conn = sqlite3.connect(f"file:{session_file}?mode=ro", uri=True, timeout=0.2)
        try:
            row = conn.execute("SELECT auth_key FROM sessions LIMIT 1").fetchone()
            return bool(row and row[0])
        finally:
            conn.close()
    except sqlite3.Error:
        return False


class TelegramAuthManager:
    def __init__(self):
        self.client = None
        self.phone = None
        self.phone_code_hash = None
        self.is_connected = False
        self._lock = None
        self._lock_loop = None
        self._status_cache = None  # (monotonic_ts, bool)

    def _get_lock(self) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        if self._lock is None or self._lock_loop is not loop:
            self._lock = asyncio.Lock()
            self._lock_loop = loop
        return self._lock

    async def get_client(self, api_id=None, api_hash=None):
        async with self._get_lock():
            if self.client and self.client.is_connected():
                try:
                    if await self.client.is_user_authorized():
                        return self.client
                    # Connected but not authorized: session might have been replaced or needs reload
                    try:
                        await self.client.disconnect()
                    except Exception:
                        pass
                    self.client = None
                except Exception:
                    self.client = None

            session_file = 'telegram_session.session'

            # Priority: Args > Env > Default/Error
            # Clean api_id: if it's not a digit string, ignore it (likely garbage from UI)
            if api_id and not str(api_id).isdigit():
                api_id = None

            real_id = api_id or os.getenv('TELEGRAM_API_ID')
            real_hash = api_hash or os.getenv('TELEGRAM_API_HASH')

            if not real_id or not str(real_id).isdigit():
                # Try reloading env
                load_dotenv()
                real_id = os.getenv('TELEGRAM_API_ID')
                real_hash = os.getenv('TELEGRAM_API_HASH')

            if not real_id or not real_hash:
                raise ValueError(f"API ID and Hash are required. Got ID: {real_id}")

            align_session_schema(session_file)
            client = TelegramClient(ResilientSQLiteSession(session_file), int(real_id), real_hash)
            try:
                await client.connect()
            except Exception:
                try:
                    await client.disconnect()
                except Exception:
                    pass
                raise
            self.client = client
            return self.client

    async def send_code(self, api_id, api_hash, phone):
        client = await self.get_client(api_id, api_hash)
        
        if not await client.is_user_authorized():
            self.phone = phone
            res = await client.send_code_request(phone)
            self.phone_code_hash = res.phone_code_hash
            return {"status": "code_sent", "message": "Code sent to your other Telegram device."}
        else:
            return {"status": "already_logged_in", "message": "Already logged in."}

    async def verify_code(self, code, password=None):
        if not self.client:
            raise ValueError("Client not initialized. Send code first.")
        
        try:
            await self.client.sign_in(phone=self.phone, code=code, phone_code_hash=self.phone_code_hash)
        except Exception as e:
            if "password" in str(e).lower() and password:
                await self.client.sign_in(password=password)
            elif "password" in str(e).lower():
                return {"status": "2fa_required", "message": "2FA Password required."}
            else:
                raise e
                
        # Save credentials to .env if successful
        self._status_cache = None
        self._save_creds(self.client.api_id, self.client.api_hash)
        return {"status": "success", "message": "Successfully logged in!"}
        
    async def verify_password(self, password):
         if not self.client: raise ValueError("Client not initialized.")
         await self.client.sign_in(password=password)
         self._status_cache = None
         self._save_creds(self.client.api_id, self.client.api_hash)
         return {"status": "success", "message": "Successfully logged in!"}

    def _save_creds(self, api_id, api_hash):
        # Allow persisting these for future restarts
        try:
            # Read existing
            lines = []
            if os.path.exists('.env'):
                with open('.env', 'r') as f: lines = f.readlines()
            
            # Filter out old
            lines = [l for l in lines if not l.startswith('TELEGRAM_API_')]
            
            # Append new
            lines.append(f"\nTELEGRAM_API_ID={api_id}\n")
            lines.append(f"TELEGRAM_API_HASH={api_hash}\n")
            
            with open('.env', 'w') as f:
                f.writelines(lines)
        except:
            pass

    async def content_status(self):
        session_file = 'telegram_session.session'
        if not os.path.exists(session_file):
            self._status_cache = None
            return False
        now = time.monotonic()
        if self._status_cache is not None and (now - self._status_cache[0]) < 5.0:
            return self._status_cache[1]
        try:
            cl = await asyncio.wait_for(self.get_client(), timeout=6.0)
            authorized = bool(cl and await asyncio.wait_for(cl.is_user_authorized(), timeout=3.0))
            self._status_cache = (time.monotonic(), authorized)
            return authorized
        except (asyncio.TimeoutError, sqlite3.OperationalError) as exc:
            logger.warning("Telegram status check fell back to read-only session probe: %s", exc)
            authorized = _session_has_auth_key(session_file)
            self._status_cache = (time.monotonic(), authorized)
            return authorized
        except Exception:
            return False

manager = TelegramAuthManager()
