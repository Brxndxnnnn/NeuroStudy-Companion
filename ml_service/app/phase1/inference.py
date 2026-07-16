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

import joblib
import numpy as np

from app.phase1 import evaluate
from app.phase1.config import DEFAULT, Phase1Config
from app.phase1.epochs import extract_session_epochs
from app.phase1.features import build_features


def load_bundle(artifact_path: str) -> dict:
    """Load a model bundle saved by train.train_and_save."""
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

    X = np.vstack([build_features(e, cfg) for e in epochs])
    sessions_arr = np.array([e.session_id for e in epochs], dtype=object)
    # One session, normalised against itself — identical to the transform each
    # session received during training.
    Xn = evaluate.per_session_zscore(X, sessions_arr)

    preds = bundle["model"].predict(Xn)
    preds = np.atleast_2d(preds)

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
