from fastapi import APIRouter
from sqlalchemy import text
from app.database import engine

router = APIRouter()


@router.get("/health", tags=["infra"])
def health():
    """
    Service liveness check.
    Verifies FastAPI is running and PostgreSQL/TimescaleDB is reachable.
    """
    try:
        with engine.connect() as conn:
            db_time = conn.execute(text("SELECT NOW()")).scalar()
        return {
            "status":   "healthy",
            "database": "connected",
            "db_time":  str(db_time),
        }
    except Exception as e:
        return {
            "status":   "unhealthy",
            "database": str(e),
        }