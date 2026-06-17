"""
tests/conftest.py

Shared fixtures for all test files.
Uses the real database — ensure your .env is loaded before running tests.

Run tests from inside the ml_service container or with your local venv:
    pytest app/tests/ -v
"""

import pytest
from sqlalchemy import text
from app.database import engine

# ── Real session ID from the database ─────────────────────────────────────────
# session ID that have both eeg_raw_samples and eeg_readings populated.
TEST_SESSION_ID = "----" # replace with the actual session ID


@pytest.fixture(scope="session")
def db_conn():
    """
    Provide a single database connection for the entire test session.
    Rolls back after all tests complete so no test data is persisted.
    """
    with engine.connect() as conn:
        yield conn


@pytest.fixture(scope="session")
def session_id():
    """Return the known test session UUID."""
    return TEST_SESSION_ID