import logging
import os
from contextlib import asynccontextmanager

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI

from app.api.health import router as health_router
from app.api.infer import router as infer_router
from app.api.insights import router as insights_router
from app.api.process import router as process_router
from app.workers import feature_jobs, prediction_jobs

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# On by default: the whole point is that nobody has to remember to start it. Set
# FEATURE_JOB_ENABLED=false to run the API without the background worker.
FEATURE_JOB_ENABLED = os.getenv("FEATURE_JOB_ENABLED", "true").lower() != "false"

# Phase 1 inference worker: runs the current model over completed sessions.
PREDICTION_JOB_ENABLED = os.getenv("PREDICTION_JOB_ENABLED", "true").lower() != "false"

# Phase 1 training cron: retrains on a cadence (default weekly). The first run
# fires one interval AFTER startup, so a deploy never triggers a retrain storm.
PHASE1_TRAIN_ENABLED = os.getenv("PHASE1_TRAIN_ENABLED", "true").lower() != "false"
PHASE1_TRAIN_INTERVAL_DAYS = int(os.getenv("PHASE1_TRAIN_INTERVAL_DAYS", "7"))


def _scheduled_train():
    """Weekly retrain. Skips quietly when there isn't enough data to fit."""
    from app.database import engine
    from app.phase1 import train
    try:
        with engine.begin() as conn:
            summary = train.train_and_save(conn)
        if summary:
            log.info(
                "Scheduled retrain produced model v%s (%s).",
                summary["model_version"],
                "now current" if summary["is_current"] else "kept as candidate",
            )
        else:
            # train_and_save has already logged the specific reason (not enough data,
            # or no new data since the current model).
            log.info("Scheduled retrain: skipped, see reason above.")
    except Exception:
        log.exception("Scheduled Phase 1 retrain failed.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Start the background jobs alongside the API, so nobody has to remember to run
    anything. Three independently-gated jobs share one scheduler:

      • feature worker   — elliptic band stats for the results chart (existing)
      • prediction worker — Phase 1 inference: runs the current model over completed
                            sessions (see workers/prediction_jobs.py)
      • training cron     — Phase 1 retrain on a cadence (default weekly)

    Several workers may be alive at once (uvicorn --workers, or the dev reloader),
    so more than one scheduler will tick. That is safe: every job claims its work
    atomically, so exactly one wins and the rest move on.
    """
    scheduler = AsyncIOScheduler()
    scheduled = False

    if FEATURE_JOB_ENABLED:
        compute_fn = feature_jobs.load_compute_fn()
        if compute_fn is None:
            # load_compute_fn has already logged why. Don't schedule a job that would
            # claim every completed session only to mark it failed.
            log.warning("Feature worker not started.")
        else:
            # Two ways this worker can run forever and achieve nothing: missing
            # migration 006, or a DB role that row-level security hides every session
            # from. Both are silent. Say so at startup.
            for problem in feature_jobs.preflight():
                log.error("Feature worker: %s", problem)

            scheduler.add_job(
                feature_jobs.tick, "interval",
                seconds=feature_jobs.POLL_INTERVAL_S,
                kwargs={"compute_fn": compute_fn},
                max_instances=1, coalesce=True, id="feature_jobs",
            )
            scheduled = True
            log.info("Feature worker started: polling every %ss.",
                     feature_jobs.POLL_INTERVAL_S)

    if PREDICTION_JOB_ENABLED:
        scheduler.add_job(
            prediction_jobs.tick, "interval",
            seconds=prediction_jobs.POLL_INTERVAL_S,
            max_instances=1, coalesce=True, id="prediction_jobs",
        )
        scheduled = True
        log.info("Prediction worker started: polling every %ss for completed "
                 "sessions to run inference on (no-op until a model is trained).",
                 prediction_jobs.POLL_INTERVAL_S)

    if PHASE1_TRAIN_ENABLED:
        scheduler.add_job(
            _scheduled_train, "interval",
            days=PHASE1_TRAIN_INTERVAL_DAYS,
            max_instances=1, coalesce=True, id="phase1_train",
        )
        scheduled = True
        log.info("Phase 1 training cron scheduled every %d day(s).",
                 PHASE1_TRAIN_INTERVAL_DAYS)

    if scheduled:
        scheduler.start()

    yield

    if scheduled:
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
app.include_router(insights_router)
app.include_router(process_router)
