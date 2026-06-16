from sqlalchemy import create_engine
from app.core.config import settings

# Single engine instance shared across the app.
# Uses DB_* env vars via settings — matches .env.docker naming.
engine = create_engine(settings.DATABASE_URL, pool_pre_ping=True)