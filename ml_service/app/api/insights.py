"""
api/insights.py

ML Phase 1 endpoints for the web Insights tab:

  GET  /phase1/status               readiness snapshot (data coverage)
  GET  /phase1/model                current model + version history
  GET  /phase1/sessions             completed sessions + prediction status
  GET  /phase1/predictions/{id}     one session's predicted valence/arousal
  POST /phase1/train                fit + register a model (admin / cron trigger)

Inference (per-session predictions) is produced automatically by the background
prediction worker; these endpoints read what it wrote. Training is offline and
occasional — the POST here is the manual lever alongside the weekly cron. It is not
surfaced in the technician UI; ml_service has no auth of its own, so treat the
train endpoint as an operator tool (see docs/ml-phase1-plan.md).
"""

from fastapi import APIRouter, HTTPException

from app.data_access import phase1_status, phase1_store
from app.database import engine
from app.phase1 import train

router = APIRouter(prefix="/phase1", tags=["ml-phase1"])

# How many DISTINCT labelled images must appear in the recorded EEG before it is
# worth training at all. The regression's real sample size is the number of
# distinct labels, not the number of epochs (every epoch from one image shares
# that image's label), and generalisation is scored by holding whole images out
# (GroupKFold-by-image). Below a few dozen distinct images there is nothing to
# hold out and no generalisation claim to make. 30 is a floor, not a goal.
DISTINCT_IMAGE_TARGET = 30


@router.get("/status")
def phase1_status_endpoint():
    """
    Readiness snapshot for the Insights tab. Aggregate counts only — safe to hit
    on a page load. See app/data_access/phase1_status.py for the join logic.
    """
    try:
        with engine.connect() as conn:
            data = phase1_status.phase1_readiness(conn)
            model = phase1_store.current_model(conn)
    except Exception as e:  # surface a clean state to the UI, never a 500 blob
        return {"available": False, "error": str(e)}

    distinct = data.get("distinct_labelled_images", 0) or 0
    ready_to_train = distinct >= DISTINCT_IMAGE_TARGET

    if not data.get("oasis_images_labelled"):
        message = (
            "OASIS labels are not loaded yet. Once images carry valence/arousal "
            "norms, sessions recorded over them become training data."
        )
    elif distinct == 0:
        message = (
            "OASIS images are labelled, but no session has recorded EEG over them "
            "yet. Record sessions using a stimulus set built from OASIS images."
        )
    elif not ready_to_train:
        message = (
            f"{distinct} of ~{DISTINCT_IMAGE_TARGET} distinct labelled images seen "
            "in recorded EEG. More sessions over more OASIS images are needed "
            "before a model can generalise."
        )
    else:
        message = (
            f"{distinct} distinct labelled images collected — enough to attempt "
            "training. Run the Phase 1 pipeline to fit and evaluate a model."
        )

    return {
        "available": True,
        "model": {
            "trained": model is not None,
            "targets": ["valence", "arousal"],
            "current_version": model["model_version"] if model else None,
        },
        "data": data,
        "readiness": {
            "distinct_images_target": DISTINCT_IMAGE_TARGET,
            "ready_to_train": ready_to_train,
            "message": message,
        },
    }


@router.get("/model")
def current_model_endpoint():
    """The current model + version history, for the tab's model card."""
    try:
        with engine.connect() as conn:
            current = phase1_store.current_model(conn)
            history = phase1_store.model_history(conn)
    except Exception as e:
        return {"available": False, "error": str(e)}
    return {"available": True, "trained": current is not None,
            "current": current, "history": history}


@router.get("/sessions")
def sessions_endpoint():
    """Completed sessions + their prediction status, for the session picker."""
    try:
        with engine.connect() as conn:
            return {"sessions": phase1_store.sessions_with_predictions(conn)}
    except Exception as e:
        return {"sessions": [], "error": str(e)}


@router.get("/predictions/{session_id}")
def predictions_endpoint(session_id: str):
    """One session's predicted valence/arousal trajectory."""
    try:
        with engine.connect() as conn:
            rows = phase1_store.fetch_session_predictions(conn, session_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"session_id": session_id, "predictions": rows, "count": len(rows)}


@router.post("/train")
def train_endpoint():
    """
    Fit + register a model on all available labelled data. This is the manual
    (operator) counterpart to the weekly training cron. Runs synchronously in a
    worker thread; on the small datasets this project has, that is a few seconds.

    NOTE: ml_service has no authentication — this is an operator tool and is not
    linked from the technician UI. See docs/ml-phase1-plan.md.
    """
    try:
        with engine.begin() as conn:
            # force=True: an operator asked explicitly, so retrain even if no new
            # data has arrived. The promotion gate still applies — a worse model is
            # registered but not made current.
            summary = train.train_and_save(conn, force=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    if summary is None:
        return {"trained": False,
                "message": "Not enough data to fit a model yet "
                           "(need at least 2 distinct labelled images)."}
    promoted = summary["is_current"]
    return {
        "trained": True,
        "promoted": promoted,
        "message": ("Trained and promoted to the current model."
                    if promoted else
                    "Trained and registered, but kept as a candidate — it did not "
                    "beat the model currently in service, which was retained."),
        "model": summary,
    }
