"""
api/insights.py

ML Phase 1 endpoints for the web Insights tab:

  GET  /phase1/status               readiness snapshot (data coverage)
  GET  /phase1/sessions             completed sessions + prediction status
  GET  /phase1/predictions/{id}     one session's predicted valence/arousal
  GET  /phase1/clients/{id}/sessions  one client's sessions + their current model
  POST /phase1/train                fit + register one client's model

Inference (per-session predictions) is produced automatically by the background
prediction worker; these endpoints read what it wrote. Training is offline and
occasional — it happens only when the POST here is called for a client.

ml_service has no auth of its own and connects to the DB as a BYPASSRLS role, so it
is NOT exposed publicly. Every one of these endpoints is reached only through the
backend's authenticated /api/ml/... proxy, which verifies the JWT and enforces
per-clinic row-level security (session/client ownership) before forwarding here.
See backend/src/routes/ml.routes.js and docs/ARCHITECTURE.md §6.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.data_access import phase1_status, phase1_store, queries
from app.database import engine
from app.phase1 import train
from app.workers import prediction_jobs

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
            "before a client's model can be trusted."
        )
    else:
        message = (
            f"{distinct} distinct labelled images collected — enough to attempt "
            "training. Run the Phase 1 pipeline to fit and evaluate a model."
        )

    return {
        "available": True,
        "data": data,
        "readiness": {
            "distinct_images_target": DISTINCT_IMAGE_TARGET,
            "ready_to_train": ready_to_train,
            "message": message,
        },
    }


@router.get("/sessions")
def sessions_endpoint():
    """Completed sessions + their prediction status, for the session picker."""
    try:
        with engine.connect() as conn:
            return {"sessions": phase1_store.sessions_with_predictions(conn)}
    except Exception as e:
        return {"sessions": [], "error": str(e)}


def _preferred_model(available: list[dict]) -> int | None:
    """
    Which model version's predictions to show by default: the newest one holding
    predictions for the session. session_prediction_models already sorts newest
    first, so this is simply the head of the list.
    """
    return int(available[0]["model_version"]) if available else None


@router.get("/predictions/{session_id}")
def predictions_endpoint(session_id: str, model_version: int | None = None):
    """
    One session's predicted valence/arousal trajectory.

    A session can hold predictions from more than one version of its client's
    model. Exactly ONE version's rows are returned — interleaving them would plot as
    a single impossible trajectory. Defaults to the newest version with predictions
    here; pass ?model_version= to switch. `available_models` lists what the tab can
    offer.
    """
    try:
        with engine.connect() as conn:
            available = phase1_store.session_prediction_models(conn, session_id)
            chosen = model_version if model_version is not None else _preferred_model(available)
            rows = (phase1_store.fetch_session_predictions(conn, session_id, chosen)
                    if chosen is not None else [])
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {
        "session_id": session_id,
        "model_version": chosen,
        "available_models": available,
        "predictions": rows,
        "count": len(rows),
    }


class TrainRequest(BaseModel):
    """
    Body for POST /phase1/train.

    client_id   the client whose model to fit. Required — every model belongs to
                exactly one client.
    session_ids restrict the fit to these sessions (the technician's selection).
                Omitted → all of that client's completed sessions.
    predict     run the new model over its training sessions immediately, so the
                tab shows predictions without waiting for a background pass.
    """
    client_id: str
    session_ids: list[str] | None = None
    predict: bool = True


@router.get("/clients/{client_id}/sessions")
def client_sessions_endpoint(client_id: str):
    """
    One client's completed sessions — what the technician picks from when generating
    that client's model — plus the model currently serving them, if any.
    """
    try:
        with engine.connect() as conn:
            session_ids = queries.fetch_client_session_ids(conn, client_id)
            model = phase1_store.current_model(conn, client_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"client_id": client_id, "session_ids": session_ids,
            "personal_model": model}


@router.post("/train")
def train_endpoint(req: TrainRequest):
    """
    Fit + register one client's model — the endpoint behind the technician's
    "generate this client's model" action. Runs synchronously; on the datasets this
    project has, that is a few seconds.

    The new model always becomes the one serving that client — the technician asked
    for it explicitly, and its honest score is returned alongside.

    Reached only through the backend's authenticated /api/ml/train proxy, which
    verifies the caller and confirms the client_id / session_ids belong to their
    clinic before forwarding here. See backend/src/routes/ml.routes.js.
    """
    try:
        with engine.begin() as conn:
            summary = train.train_and_save(
                conn, req.client_id, session_ids=req.session_ids,
            )
            # Sessions already marked done under an older model would never be
            # revisited by the worker; requeue them so they pick up this model.
            if summary:
                prediction_jobs.requeue_client(conn, req.client_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    if summary is None:
        return {"trained": False,
                "message": ("Not enough data to fit a model yet — this client needs "
                            "at least 2 distinct labelled images across the selected "
                            "sessions.")}

    inferred = None
    if req.predict:
        # Predict over the sessions the model was actually fitted on, so the tab has
        # something to show immediately. Outside the training transaction: inference
        # failing must not roll back a model that trained fine.
        trained_on = req.session_ids
        if trained_on is None:
            with engine.connect() as conn:
                trained_on = phase1_store.model_sessions(conn, summary["model_version"])
        if trained_on:
            inferred = prediction_jobs.predict_sessions_with_model(summary, trained_on)

    return {
        "trained": True,
        "message": ("Trained this client's personal model — it is now the one their "
                    "Insights tab uses."),
        "model": summary,
        "inference": inferred,
    }
