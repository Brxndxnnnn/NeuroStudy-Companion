import logging
import os
from contextlib import asynccontextmanager

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI

from app.api.health import router as health_router
from app.api.infer import router as infer_router
from app.workers import feature_jobs

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# On by default: the whole point is that nobody has to remember to start it. Set
# FEATURE_JOB_ENABLED=false to run the API without the background worker.
FEATURE_JOB_ENABLED = os.getenv("FEATURE_JOB_ENABLED", "true").lower() != "false"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Start the feature worker alongside the API, so a completed session gets its
    features computed without anyone running anything.

    Several workers may be alive at once (uvicorn --workers, or the dev reloader),
    so more than one scheduler will tick. That is safe: feature_jobs claims each
    session with an atomic UPDATE ... RETURNING, so exactly one of them wins and the
    rest move on. See feature_jobs' module docstring.
    """
    scheduler = None
    if FEATURE_JOB_ENABLED:
        compute_fn = feature_jobs.load_compute_fn()
        if compute_fn is None:
            # load_compute_fn has already logged why. Don't schedule a job that would
            # claim every completed session only to mark it failed.
            log.warning("Feature worker not started.")
        else:
            scheduler = AsyncIOScheduler()
            scheduler.add_job(
                feature_jobs.tick,
                "interval",
                seconds=feature_jobs.POLL_INTERVAL_S,
                kwargs={"compute_fn": compute_fn},
                # A slow session must not stack ticks on top of each other.
                max_instances=1,
                coalesce=True,
                id="feature_jobs",
            )
            scheduler.start()
            log.info(
                "Feature worker started: polling every %ss for sessions with "
                "sync_status='completed' and no features yet.",
                feature_jobs.POLL_INTERVAL_S,
            )

    yield

    if scheduler:
        scheduler.shutdown(wait=False)


app = FastAPI(
    title="NeuroStudy ML Service",
    description=(
        "EEG signal processing and ML inference service "
        "for the NeuroStudy Companion platform."
    ),
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(health_router)
app.include_router(infer_router)
