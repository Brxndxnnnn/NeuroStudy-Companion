"""
phase1/inference.py

Run a trained Phase 1 model over one session's EEG and produce per-window
valence/arousal predictions.

Inference reuses the epoching, feature, and normalisation code from training. It
runs ONLY over OASIS-labelled images (require_label=True): as sessions transition
to OASIS imagery, predictions appear for exactly the images that carry a
valence/arousal ground truth, and the placeholder images are ignored. A session
recorded entirely on placeholders yields no predictions. The output is a per-window
trajectory, one prediction per 2 s epoch.
"""

from __future__ import annotations

import logging
import os

import joblib
import numpy as np

from app.data_access import queries
from app.data_access.queries import BFI_DOMAINS
from app.phase1 import evaluate
from app.phase1.config import DEFAULT, OASIS_SCALE_MAX, OASIS_SCALE_MIN, Phase1Config
from app.phase1.epochs import extract_session_epochs
from app.phase1.features import build_features

log = logging.getLogger(__name__)

# Per-session z-scoring normalises a session's features against that session's own
# mean/std. Estimated from only one or two epochs, those statistics are noise: a
# single-epoch session collapses to all-zero features (mean == the row), and the
# model then emits one constant value for the whole session. Rather than write a
# flat, meaningless "trajectory" that reads on the tab as a real result, decline to
# predict below this many labelled epochs. At the real 10 s image duration one image
# already yields ~17 epochs, so this only ever trims pathologically short sessions.
MIN_SESSION_EPOCHS = int(os.getenv("PHASE1_MIN_SESSION_EPOCHS", "4"))


def load_bundle(artifact_path: str) -> dict:
    """Load a model bundle saved by train.train_group_and_save."""
    return joblib.load(artifact_path)


def predict_session(
    conn,
    session_id: str,
    bundle: dict,
    model_version: int,
    cfg: Phase1Config = DEFAULT,
) -> list[dict]:
    """
    Predict valence/arousal for every epoch of one session.

    Returns rows shaped for phase1_store.replace_session_predictions. An empty list
    is a normal outcome — a session with dead electrodes, no bounded image windows,
    or no OASIS-labelled images yields no epochs, which is recorded as a successful
    run with zero predictions.
    """
    epochs, _ = extract_session_epochs(conn, session_id, cfg, require_label=True)
    if not epochs:
        return []

    if len(epochs) < MIN_SESSION_EPOCHS:
        # Too few epochs to normalise against reliably; predicting here would emit a
        # constant that looks like a real result. Recorded as a successful run with
        # zero predictions (same outcome the worker gives a no-OASIS-images session).
        log.info(
            "Session %s has only %d labelled epoch(s) (< %d); skipping inference to "
            "avoid an unreliable flat prediction.",
            session_id, len(epochs), MIN_SESSION_EPOCHS,
        )
        return []

    X = np.vstack([build_features(e, cfg) for e in epochs])
    sessions_arr = np.array([e.session_id for e in epochs], dtype=object)
    # One session, normalised against itself — identical to the transform each
    # session received during training.
    Xn = evaluate.per_session_zscore(X, sessions_arr)

    if bundle.get("uses_bfi"):
        # Group models take the client's BFI-2 domain means as extra inputs, appended
        # after the z-scoring exactly as in training. Same source rule as training: this
        # session's own BFI-2 if complete, else the client's latest complete one.
        client_id = queries.fetch_session_client(conn, session_id)
        bfi = queries.fetch_client_bfi(conn, client_id, session_id) if client_id else None
        if bfi is None:
            log.info("Session %s: client has no complete BFI-2; the group model cannot "
                     "predict it.", session_id)
            return []
        domains = bundle.get("bfi_domains") or list(BFI_DOMAINS)
        row = np.array([bfi[d] for d in domains], dtype=np.float64)
        Xn = np.hstack([Xn, np.tile(row, (len(Xn), 1))])

    preds = bundle["model"].predict(Xn)
    preds = np.atleast_2d(preds)
    # Clamp to the OASIS 1–7 scale: the model can extrapolate past it, and an
    # out-of-range value is meaningless charted against the OASIS ground truth.
    preds = np.clip(preds, OASIS_SCALE_MIN, OASIS_SCALE_MAX)

    return [
        {
            "session_id":     session_id,
            "model_version":  model_version,
            "window_start":   e.t_start,
            "window_end":     e.t_end,
            "pred_valence":   float(p[0]),
            "pred_arousal":   float(p[1]),
            # Ground truth: the OASIS rating of the image on screen. Present on
            # every row because inference is label-only. Lets the tab show
            # predicted vs actual.
            "actual_valence": float(e.valence),
            "actual_arousal": float(e.arousal),
            "image_id":       e.image_id,
        }
        for e, p in zip(epochs, preds)
    ]
