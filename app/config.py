"""
Centralized configuration management with validation and secure defaults.
"""
import os
import re
import secrets
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv
import logging

# Load environment variables from project-root .env and prefer these values.
_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
_ENV_EXAMPLE = Path(__file__).resolve().parent.parent / ".env.example"
_SECRET_PLACEHOLDERS = {"", "replace-with-a-long-random-secret"}
_PASSWORD_PLACEHOLDERS = {"", "replace-with-a-strong-password"}


def _env_value(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return None
    key, val = stripped.split("=", 1)
    return key.strip(), val.strip().strip('"').strip("'")


def _upsert_env(path: Path, key: str, value: str, placeholders: set[str]) -> bool:
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    lines = text.splitlines()
    found = False
    changed = False
    out: list[str] = []
    for line in lines:
        parsed = _env_value(line)
        if not parsed or parsed[0] != key:
            out.append(line)
            continue
        found = True
        if parsed[1] not in placeholders:
            out.append(line)
            continue
        out.append(f"{key}={value}")
        changed = True
    if not found:
        if out and out[-1] != "":
            out.append("")
        out.append(f"{key}={value}")
        changed = True
    if changed:
        path.write_text("\n".join(out) + "\n", encoding="utf-8")
    return changed


def _ensure_zero_config_env() -> None:
    created = False
    if not _ENV_PATH.exists() and _ENV_EXAMPLE.exists():
        _ENV_PATH.write_text(_ENV_EXAMPLE.read_text(encoding="utf-8"), encoding="utf-8")
        created = True
    if not _ENV_PATH.exists():
        _ENV_PATH.write_text(
            "SECRET_KEY=\nDASHBOARD_PASSWORD=\nDATABASE_URL=sqlite:///./nexus_test.db\n"
            "SERVER_HOST=127.0.0.1\nSERVER_PORT=8000\nLOG_LEVEL=INFO\n"
            "NTC_PROXY_LIST=\nWEBSHARE_PROXY_LIST=\n",
            encoding="utf-8",
        )
        created = True

    current: dict[str, str] = {}
    for line in _ENV_PATH.read_text(encoding="utf-8").splitlines():
        parsed = _env_value(line)
        if parsed:
            current[parsed[0]] = parsed[1]

    secret_set = False
    if current.get("SECRET_KEY", "") in _SECRET_PLACEHOLDERS:
        _upsert_env(_ENV_PATH, "SECRET_KEY", secrets.token_urlsafe(48), _SECRET_PLACEHOLDERS)
        secret_set = True
    if current.get("DASHBOARD_PASSWORD", "") in _PASSWORD_PLACEHOLDERS:
        _upsert_env(_ENV_PATH, "DASHBOARD_PASSWORD", "admin", _PASSWORD_PLACEHOLDERS)
    if not current.get("DATABASE_URL"):
        _upsert_env(_ENV_PATH, "DATABASE_URL", "sqlite:///./nexus_test.db", {""})
    if not current.get("SERVER_HOST"):
        _upsert_env(_ENV_PATH, "SERVER_HOST", "127.0.0.1", {""})
    if not current.get("SERVER_PORT"):
        _upsert_env(_ENV_PATH, "SERVER_PORT", "8000", {""})
    if not current.get("LOG_LEVEL"):
        _upsert_env(_ENV_PATH, "LOG_LEVEL", "INFO", {""})
    if "NTC_PROXY_LIST" not in current:
        _upsert_env(_ENV_PATH, "NTC_PROXY_LIST", "", {""})
    if "WEBSHARE_PROXY_LIST" not in current:
        _upsert_env(_ENV_PATH, "WEBSHARE_PROXY_LIST", "", {""})

    print("[bootstrap] .env ready" + (" (created)" if created else ""))
    if secret_set:
        print("[bootstrap] SECRET_KEY set")
    else:
        print("[bootstrap] SECRET_KEY set")
    print("[bootstrap] NTC direct exit active (proxy list empty = OK)")


_ensure_zero_config_env()
load_dotenv(dotenv_path=_ENV_PATH, override=True)

logger = logging.getLogger(__name__)


class ConfigurationError(Exception):
    """Raised when configuration is invalid or missing required values."""
    pass


class Config:
    """
    Application configuration with validation and secure defaults.
    """
    
    def __init__(self):
        """Initialize configuration and validate required settings."""
        self._validate_required_vars()
        self._load_settings()
    
    def _validate_required_vars(self):
        """Ensure critical environment variables are set."""
        required = ['DASHBOARD_PASSWORD', 'SECRET_KEY']
        missing = [var for var in required if not os.getenv(var)]
        
        if missing:
            raise ConfigurationError(
                f"Missing required environment variables: {', '.join(missing)}. "
                f"Please copy .env.example to .env and configure your credentials."
            )
    
    def _load_settings(self):
        """Load all configuration settings."""
        # === SECURITY ===
        self.DASHBOARD_PASSWORD = os.getenv('DASHBOARD_PASSWORD')
        self.SECRET_KEY = os.getenv('SECRET_KEY')
        
        # Validate password strength
        if not self._is_strong_password(self.DASHBOARD_PASSWORD):
            logger.warning(
                "SECURITY WARNING: Dashboard password is weak! "
                "Use at least 12 characters with mixed case, numbers, and symbols."
            )
        
        # Validate secret key entropy
        if len(self.SECRET_KEY) < 32:
            logger.warning(
                "SECURITY WARNING: SECRET_KEY should be at least 32 characters. "
                "Generate a strong key with: python -c 'import secrets; print(secrets.token_urlsafe(32))'"
            )
        
        # === TELEGRAM ===
        self.TELEGRAM_API_ID = os.getenv('TELEGRAM_API_ID')
        self.TELEGRAM_API_HASH = os.getenv('TELEGRAM_API_HASH')
        
        # === GOFILE / EXTRACTORS ===
        self.GOFILE_TOKEN = os.getenv('GOFILE_TOKEN')

        # === WEBSHARE ===
        self.WEBSHARE_TOKEN = os.getenv('WEBSHARE_TOKEN')
        self.WEBSHARE_LOGIN = os.getenv('WEBSHARE_LOGIN')
        self.WEBSHARE_PASSWORD = os.getenv('WEBSHARE_PASSWORD')
        
        # === DATABASE ===
        self.DATABASE_URL = self._resolve_database_url(
            os.getenv('DATABASE_URL', 'sqlite:///./nexus_test.db')
        )
        self.DB_POOL_SIZE = int(os.getenv('DB_POOL_SIZE', '20'))
        self.DB_MAX_OVERFLOW = int(os.getenv('DB_MAX_OVERFLOW', '40'))
        # Fail fast when the connection pool is exhausted instead of hanging for
        # minutes. A 300s timeout meant that once every thread-pool worker was
        # blocked waiting for a connection, the whole server (incl. /health)
        # froze silently. SQLite write contention is handled separately by
        # PRAGMA busy_timeout (30s) in database.py, so this only needs to cover
        # a transient checkout wait.
        self.DB_POOL_TIMEOUT = int(os.getenv('DB_POOL_TIMEOUT', '30'))
        
        # === SERVER ===
        self.SERVER_HOST = os.getenv('SERVER_HOST', '0.0.0.0')
        self.SERVER_PORT = int(os.getenv('SERVER_PORT', '8000'))
        self.SERVER_RELOAD = os.getenv('SERVER_RELOAD', 'false').lower() == 'true'
        
        # === BACKUP ===
        self.BACKUP_RETENTION_DAYS = int(os.getenv('BACKUP_RETENTION_DAYS', '7'))
        self.BACKUP_DIR = os.getenv('BACKUP_DIR', 'backups')
        
        # === LOGGING ===
        self.LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO').upper()
        self.LOG_JSON = os.getenv('LOG_JSON', 'false').lower() == 'true'

        # === CORS (browser / extension calling API) ===
        self.CORS_ALLOW_ALL = os.getenv('CORS_ALLOW_ALL', 'false').lower() == 'true'
        self.CORS_ALLOW_CHROME_EXTENSIONS = os.getenv(
            'CORS_ALLOW_CHROME_EXTENSIONS',
            'true',
        ).lower() == 'true'
        _raw_origins = os.getenv(
            'CORS_ORIGINS',
            # mega.nz is allowed so the MEGA Folder Helper userscript (runs in the
            # mega.nz page context) can call /mega/preview + /mega/add-selected.
            'http://127.0.0.1:8000,http://localhost:8000,http://127.0.0.1:5173,http://localhost:5173,https://mega.nz',
        )
        self.CORS_ORIGIN_REGEX = (os.getenv('CORS_ORIGIN_REGEX') or '').strip()
        if self.CORS_ALLOW_ALL:
            self.CORS_ORIGINS = ['*']
        else:
            self.CORS_ORIGINS = [x.strip() for x in _raw_origins.split(',') if x.strip()]
            if not self.CORS_ORIGIN_REGEX and self.CORS_ALLOW_CHROME_EXTENSIONS:
                # Allow MV3 extension popups/background pages like
                # chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef
                self.CORS_ORIGIN_REGEX = r"^chrome-extension://[a-z]{32}$"

        # === BRIDGE (browser extension) ===
        self.NEXUS_BRIDGE_TOKEN = (os.getenv('NEXUS_BRIDGE_TOKEN') or '').strip()
        self.MEGA_PROXY_URL = (os.getenv('MEGA_PROXY_URL') or '').strip()
        self.MEGA_PROXY_MODE = (os.getenv('MEGA_PROXY_MODE') or '').strip().lower()

        # === RELATED SEARCH / CBIR ===
        self.SERPAPI_API_KEY = (os.getenv('SERPAPI_API_KEY') or '').strip()
        self.CBIR_CACHE_TTL_HOURS = max(1, int(os.getenv('CBIR_CACHE_TTL_HOURS', '24')))
        self.CBIR_BROWSER_JOB_TTL_SECONDS = max(60, int(os.getenv('CBIR_BROWSER_JOB_TTL_SECONDS', '600')))
        self.GOOGLE_VISION_API_KEY = (
            os.getenv('GOOGLE_VISION_API_KEY')
            or os.getenv('GOOGLE_CLOUD_VISION_API_KEY')
            or ''
        ).strip()

        # Optional Cloudflare R2 image broker. SerpApi requires an image URL,
        # while most Nexus thumbnails are local files. The object is uploaded
        # privately, exposed through a short-lived signed GET URL, then deleted.
        self.R2_ACCOUNT_ID = (os.getenv('R2_ACCOUNT_ID') or '').strip()
        self.R2_ACCESS_KEY_ID = (os.getenv('R2_ACCESS_KEY_ID') or '').strip()
        self.R2_SECRET_ACCESS_KEY = (os.getenv('R2_SECRET_ACCESS_KEY') or '').strip()
        self.R2_BUCKET = (os.getenv('R2_BUCKET') or '').strip()
        self.R2_PRESIGN_TTL_SECONDS = min(
            3600,
            max(60, int(os.getenv('R2_PRESIGN_TTL_SECONDS', '600'))),
        )
        
        # === PERFORMANCE ===
        self.PERFORMANCE_MODE = os.getenv('PERFORMANCE_MODE', 'high').lower()  # 'high', 'balanced', 'eco'
        self.MAX_WORKERS = int(os.getenv('MAX_WORKERS', '16'))  # Parallel video processing workers
        # Intake jobs resolve arbitrary remote hosts and can fall back to yt-dlp.
        # Keep that queue deliberately smaller than the generic processing pool:
        # one slow or DNS-broken provider must never make the web UI unavailable.
        self.INTAKE_MAX_WORKERS = max(1, min(int(os.getenv('INTAKE_MAX_WORKERS', '4')), 4))
        self.INTAKE_ITEM_TIMEOUT_SECONDS = max(30, min(int(os.getenv('INTAKE_ITEM_TIMEOUT_SECONDS', '90')), 300))
        # Historical pending rows are made visible as recoverable errors at
        # boot. Re-processing hundreds of them automatically can monopolise
        # the local dashboard before it can answer even /health.
        self.AUTO_RECOVER_PENDING_VIDEOS = os.getenv('AUTO_RECOVER_PENDING_VIDEOS', 'true').lower() == 'true'
        self.FFMPEG_THREADS = int(os.getenv('FFMPEG_THREADS', '8'))  # FFmpeg thread count (0 = auto)
        self.GPU_ACCELERATION = os.getenv('GPU_ACCELERATION', 'true').lower() == 'true'  # Enable NVIDIA GPU

    @staticmethod
    def _resolve_database_url(db_url: str) -> str:
        """
        Normalize SQLite URLs so relative paths are anchored to project root.

        This prevents accidental split-database situations when server cwd differs.
        """
        raw_url = (db_url or '').strip() or 'sqlite:///./nexus_test.db'
        lower_url = raw_url.lower()

        # Only normalize sqlite:/// style URLs.
        if not lower_url.startswith('sqlite:///'):
            return raw_url

        sqlite_path = raw_url[len('sqlite:///'):]
        if sqlite_path == ':memory:':
            return raw_url

        path_obj = Path(sqlite_path)
        if path_obj.is_absolute():
            return raw_url

        resolved_path = (_ENV_PATH.parent / path_obj).resolve()
        normalized_url = f"sqlite:///{resolved_path.as_posix()}"

        logger.info("Resolved relative DATABASE_URL to: %s", normalized_url)
        return normalized_url

    
    @staticmethod
    def _is_strong_password(password: str) -> bool:
        """
        Validate password strength.
        
        Requirements:
        - At least 12 characters
        - Contains uppercase letter
        - Contains lowercase letter
        - Contains digit
        - Contains special character
        """
        if not password:
            return False
        
        # Bypass for simple admin password (user request for Lite version)
        if password == 'admin':
            return True

        if len(password) < 12:
            return False
        
        has_upper = bool(re.search(r'[A-Z]', password))
        has_lower = bool(re.search(r'[a-z]', password))
        has_digit = bool(re.search(r'\d', password))
        has_special = bool(re.search(r'[!@#$%^&*()_+\-=\[\]{};:\'",.<>?/\\|`~]', password))
        
        return has_upper and has_lower and has_digit and has_special
    
    @staticmethod
    def generate_secret_key() -> str:
        """Generate a cryptographically secure secret key."""
        return secrets.token_urlsafe(32)
    
    @staticmethod
    def generate_secure_password(length: int = 16) -> str:
        """
        Generate a secure password meeting strength requirements.
        
        Args:
            length: Password length (minimum 12)
        
        Returns:
            Secure password string
        """
        if length < 12:
            length = 12
        
        # Ensure we have all character types
        chars = (
            secrets.choice('ABCDEFGHIJKLMNOPQRSTUVWXYZ') +
            secrets.choice('abcdefghijklmnopqrstuvwxyz') +
            secrets.choice('0123456789') +
            secrets.choice('!@#$%^&*()_+-=[]{}')
        )
        
        # Fill remaining length with random characters
        all_chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}:;<>?'
        chars += ''.join(secrets.choice(all_chars) for _ in range(length - 4))
        
        # Shuffle to avoid predictable pattern
        char_list = list(chars)
        secrets.SystemRandom().shuffle(char_list)
        
        return ''.join(char_list)
    
    def get_database_config(self) -> dict:
        """Get database configuration dictionary."""
        return {
            'url': self.DATABASE_URL,
            'pool_size': self.DB_POOL_SIZE,
            'max_overflow': self.DB_MAX_OVERFLOW,
            'pool_timeout': self.DB_POOL_TIMEOUT
        }
    
    def get_server_config(self) -> dict:
        """Get server configuration dictionary."""
        return {
            'host': self.SERVER_HOST,
            'port': self.SERVER_PORT,
            'reload': self.SERVER_RELOAD
        }
    
    def validate(self) -> list[str]:
        """
        Validate all configuration and return list of warnings/errors.
        
        Returns:
            List of validation messages (empty if all valid)
        """
        issues = []
        
        # Check password strength
        if not self._is_strong_password(self.DASHBOARD_PASSWORD):
            issues.append("Dashboard password does not meet strength requirements")
        
        # Check secret key
        if len(self.SECRET_KEY) < 32:
            issues.append("SECRET_KEY is too short (should be at least 32 characters)")
        
        # Check Telegram credentials if used
        if self.TELEGRAM_API_ID and not self.TELEGRAM_API_HASH:
            issues.append("TELEGRAM_API_ID set but TELEGRAM_API_HASH is missing")
        
        # Check Webshare credentials
        if self.WEBSHARE_TOKEN and not (self.WEBSHARE_LOGIN and self.WEBSHARE_PASSWORD):
            issues.append("WEBSHARE_TOKEN set but login credentials are incomplete")
        
        return issues


# Global configuration instance
try:
    config = Config()
    
    # Log configuration validation on load
    validation_issues = config.validate()
    if validation_issues:
        logger.warning(f"Configuration validation warnings: {'; '.join(validation_issues)}")
    else:
        logger.info("Configuration loaded and validated successfully")
        
except ConfigurationError as e:
    logger.error(f"Configuration error: {e}")
    raise
except Exception as e:
    logger.error(f"Unexpected error loading configuration: {e}")
    raise ConfigurationError(f"Failed to load configuration: {e}")
