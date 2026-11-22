"""Location and one-time migration for local playlist fetch history."""

from pathlib import Path
import shutil


PROJECT_ROOT = Path(__file__).resolve().parent.parent
HISTORY_DIR = PROJECT_ROOT / "data" / "playlist_fetches"
LEGACY_DIR = PROJECT_ROOT / "app" / "playlist_fetches"


def playlist_history_dir() -> str:
    """Return the private runtime directory, preserving old local records."""
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    migration_marker = HISTORY_DIR / ".legacy_imported"
    if not migration_marker.exists() and LEGACY_DIR.is_dir():
        for source in LEGACY_DIR.glob("*.json"):
            destination = HISTORY_DIR / source.name
            if not destination.exists():
                shutil.copy2(source, destination)
        migration_marker.touch()
    return str(HISTORY_DIR)
