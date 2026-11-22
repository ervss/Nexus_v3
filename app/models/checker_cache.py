from datetime import datetime, timezone, timedelta
from sqlalchemy import Column, Integer, String, BigInteger, DateTime, Text, Index
from app.database import Base, utcnow, engine

class CheckerCache(Base):
    __tablename__ = "checker_cache"

    id = Column(Integer, primary_key=True, index=True)
    embed_url = Column(String, unique=True, index=True, nullable=False)
    server = Column(String, nullable=False)
    direct_url = Column(Text, nullable=True)
    quality = Column(String, nullable=True)
    size_bytes = Column(BigInteger, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utcnow, nullable=False)

    def is_valid(self, ttl_seconds: int = 3600) -> bool:
        """Overí či je záznam v cache mladší ako TTL (predvolene 1 hodina)."""
        if not self.created_at:
            return False
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        return (now - self.created_at) < timedelta(seconds=ttl_seconds)

# Vytvor tabuľku ak neexistuje
try:
    CheckerCache.__table__.create(bind=engine, checkfirst=True)
except Exception:
    pass
