"""
api/insights.py

ML Phase 1 endpoints for the web Insights tab:

  GET  /phase1/status                     readiness snapshot (data coverage)
  GET  /phase1/sessions                   completed sessions + prediction status
  GET  /phase1/predictions/{id}           one session's predicted valence/arousal
  GET  /phase1/eligibility                per client: latest trainable session, BFI-2
  GET  /phase1/groups/models              every group's current model + scores
  POST /phase1/groups/{group_id}/train    fit + register one group's model
  GET  /phase1/groups/{group_id}/fit      how a client compares with the group

Groups themselves (names, members) are clinic data managed by the backend; this
service only reads them. Inference (per-session predictions) is produced
automatically by the background prediction worker; these endpoints read what it
wrote. Training is offline and occasional — it happens only when the POST here is
called for a group.

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
from app.phase1 import group_fit, train
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


class GroupTrainRequest(BaseModel):
    """
    Body for POST /phase1/groups/{group_id}/train.

    predict  run the new model over every member's completed sessions immediately,
             so the tab shows predictions without waiting for a background pass.
    """
    predict: bool = True


@router.get("/eligibility")
def eligibility_endpoint():
    """
    Per client: the latest session a group model would use and whether a complete
    BFI-2 exists — shown in the group editor so the technician knows who can
    contribute before training. Cross-clinic; the backend trims it.
    """
    try:
        with engine.connect() as conn:
            return {"clients": queries.fetch_client_eligibility(conn),
                    "min_session_labelled_images": queries.MIN_SESSION_LABELLED_IMAGES}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/groups/models")
def group_models_endpoint():
    """Every group's current model, its scores, and who trained it."""
    try:
        with engine.connect() as conn:
            return {"models": phase1_store.group_models_summary(conn)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/groups/{group_id}/train")
def group_train_endpoint(group_id: str, req: GroupTrainRequest):
    """
    Fit + register one group's model — the endpoint behind the technician's Train
    button. Runs synchronously; on this project's data that is a few seconds per member.

    The new model always becomes the group's current one, and its honest scores (with
    and without BFI, against the predict-the-mean baseline) are returned with it.

    Reached only through the backend's authenticated proxy, which confirms the group
    belongs to the caller's clinic before forwarding here.
    """
    try:
        with engine.begin() as conn:
            if queries.fetch_group(conn, group_id) is None:
                raise HTTPException(status_code=404, detail="Group not found.")
            summary = train.train_group_and_save(conn, group_id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    if not summary.get("trained"):
        return summary

    inferred = None
    if req.predict:
        # Every completed session of every member, not just the training ones, so the
        # tab can show this model on any of their recordings. Outside the training
        # transaction: inference failing must not roll back a model that trained fine.
        with engine.connect() as conn:
            session_ids = phase1_store.group_session_ids(conn, group_id)
        if session_ids:
            inferred = prediction_jobs.predict_sessions_with_model(summary, session_ids)

    return {**summary, "inference": inferred}


@router.get("/groups/{group_id}/fit")
def group_fit_endpoint(group_id: str, client_id: str):
    """
    How a client outside the group compares with it: personality (BFI-2), EEG profile
    (frequency-band shares) and response (the group's model scored on them). Each is
    placed in the range of the members' own scores. Read-only; nothing is saved.

    Reached only through the backend's authenticated proxy, which confirms the group
    and the client both belong to the caller's clinic before forwarding here.
    """
    try:
        with engine.connect() as conn:
            return group_fit.compare_client(conn, group_id, client_id)
    except group_fit.FitError as e:
        raise HTTPException(status_code=e.status, detail=e.message)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
