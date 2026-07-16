"""
phase1/train.py

Fit a Phase 1 valence/arousal model on ALL available labelled data, persist it as a
joblib artifact, and register it in ml_models. This is the step that turns the
evaluation harness (which only cross-validates and throws its models away) into
something inference can serve.

Training is OFFLINE and OCCASIONAL — a weekly cron or an admin trigger — never
per-session. See docs/ml-phase1-plan.md.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone

import joblib
import numpy as np

from app.core.config import settings
from app.phase1 import evaluate
from app.phase1.config import DEFAULT, Phase1Config
from app.phase1.dataset import build_dataset
from app.phase1.features import feature_names
from app.data_access import phase1_store

log = logging.getLogger(__name__)

# Which model to serve. Ridge is the sane default at this data scale; override with
# PHASE1_MODEL=random_forest if wanted.
DEFAULT_ALGO = os.getenv("PHASE1_MODEL", "ridge")

# Minimum distinct images before a retrain is worth doing at all. Below 2 there is
# no cross-validation to run and, honestly, nothing to learn — but note the
# "accuracy doesn't matter" stance: we still FIT and SERVE a model on whatever
# exists, we just can't report an honest generalisation number for it.
MIN_IMAGES_TO_FIT = int(os.getenv("PHASE1_MIN_IMAGES", "2"))


def _empty_metrics() -> tuple[dict, dict]:
    nan = {"valence": None, "arousal": None}
    return {"r2": dict(nan), "mae": dict(nan)}, {"r2": dict(nan)}


def train_and_save(
    conn,
    cfg: Phase1Config = DEFAULT,
    algo: str = DEFAULT_ALGO,
    make_current: bool = True,
) -> dict | None:
    """
    Train, persist, and register one model. Returns a summary dict, or None if
    there is not enough data to fit anything.

    Does not commit — the caller owns the transaction (so a failed file write or DB
    insert rolls back cleanly). The artifact file is written before the DB row; a
    rolled-back transaction can leave an unreferenced .joblib on disk, which is
    harmless.
    """
    X, y, groups, sessions, _ = build_dataset(conn, None, cfg, verbose=False)
    n_epochs = int(X.shape[0])
    n_images = int(len(np.unique(groups))) if n_epochs else 0
    n_sessions = int(len(np.unique(sessions))) if n_epochs else 0

    if n_epochs == 0 or n_images < MIN_IMAGES_TO_FIT:
        log.info(
            "Phase 1 training skipped: %d epochs from %d distinct images "
            "(need >= %d images).", n_epochs, n_images, MIN_IMAGES_TO_FIT,
        )
        return None

    if algo not in evaluate.make_models():
        raise ValueError(f"Unknown model '{algo}'. Choices: "
                         f"{list(evaluate.make_models())}")

    # Honest generalisation score, when there are enough images to hold some out.
    # GroupKFold needs n_splits <= n_distinct_images, so clamp it — otherwise a
    # tiny dataset raises instead of training.
    if n_images >= 2:
        n_splits = min(5, n_images)
        res = evaluate.cross_validate(
            X, y, groups, sessions,
            evaluate.make_models()[algo], algo,
            n_splits=n_splits, grouped=True,
        )
        cv = {"r2": res.r2, "mae": res.mae}
        null = {"r2": res.null_r2}
    else:
        cv, null = _empty_metrics()

    # Final model: fit on everything, using the same per-session normalisation the
    # CV used (and that inference will apply to a new session against itself).
    Xn = evaluate.per_session_zscore(X, sessions)
    model = evaluate.make_models()[algo]
    model.fit(Xn, y)

    bundle = {
        "model": model,
        "algo": algo,
        "feature_names": feature_names(),
        "targets": list(evaluate.TARGETS),
        "epoch_s": cfg.epoch_s,
        "step_s": cfg.step_s,
    }

    os.makedirs(settings.MODEL_DIR, exist_ok=True)
    fname = f"phase1_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}_{algo}.joblib"
    path = os.path.join(settings.MODEL_DIR, fname)
    joblib.dump(bundle, path)

    version = phase1_store.insert_model(
        conn, algo=algo, artifact_path=path,
        n_epochs=n_epochs, n_distinct_images=n_images, n_sessions=n_sessions,
        cv=cv, null=null, make_current=make_current,
    )

    log.info(
        "Trained Phase 1 model v%d (%s) on %d epochs / %d images / %d sessions.",
        version, algo, n_epochs, n_images, n_sessions,
    )
    return {
        "model_version": version,
        "algo": algo,
        "n_epochs": n_epochs,
        "n_distinct_images": n_images,
        "n_sessions": n_sessions,
        "cv": cv,
        "null": null,
        "artifact_path": path,
        "is_current": make_current,
    }
