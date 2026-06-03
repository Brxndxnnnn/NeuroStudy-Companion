from fastapi import FastAPI
from app.database import engine

app = FastAPI()

@app.get("/health")
def health():
    try:
        conn = engine.connect()
        conn.close()

        return {
            "status": "healthy",
            "database": "connected"
        }

    except Exception as e:
        return {
            "status": "unhealthy",
            "database": str(e)
        }