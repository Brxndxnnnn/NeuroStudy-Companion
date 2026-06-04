# from fastapi import FastAPI
# from app.database import engine

# app = FastAPI()

# @app.get("/health")
# def health():
#     try:
#         conn = engine.connect()
#         conn.close()

#         return {
#             "status": "healthy",
#             "database": "connected"
#         }

#     except Exception as e:
#         return {
#             "status": "unhealthy",
#             "database": str(e)
#         }
from fastapi import FastAPI
from sqlalchemy import text
from app.database import engine

app = FastAPI()

@app.get("/health")
def health():
    try:
        with engine.connect() as conn:
            result = conn.execute(text("SELECT NOW()"))
            db_time = result.scalar()

        return {
            "status": "healthy",
            "database": "connected",
            "db_time": str(db_time)
        }

    except Exception as e:
        return {
            "status": "unhealthy",
            "database": str(e)
        }


@app.get("/db-test-read")
def db_test_read():
    try:
        with engine.connect() as conn:
            result = conn.execute(text("SELECT 1"))
            value = result.scalar()

        return {
            "status": "success",
            "value": value
        }

    except Exception as e:
        return {"error": str(e)}


@app.get("/db-test-write")
def db_test_write():
    try:
        with engine.begin() as conn:
            conn.execute(
                text("""
                CREATE TABLE IF NOT EXISTS ml_test (
                    id SERIAL PRIMARY KEY,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """)
            )

            conn.execute(
                text("INSERT INTO ml_test DEFAULT VALUES")
            )

        return {
            "status": "success",
            "message": "Record inserted"
        }

    except Exception as e:
        return {"error": str(e)}