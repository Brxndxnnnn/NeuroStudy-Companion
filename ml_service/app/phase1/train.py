"""
phase1/train.py

Fit a Phase 1 valence/arousal model on ALL available labelled data, persist it as a
joblib artifact, and register it in ml_models. This is the step that turns the
evaluation harness (which only cross-validates and throws its models away) into
something inference can serve.

Training is OFFLINE and OCCASIONAL — a weekly cron or an admin trigger — never
per-session. See docs/ARCHITECTURE.md §6.
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
from app.data_access import phase1_store, queries

log = logging.getLogger(__name__)

# Which model to serve. Ridge is the sane default at this data scale; override with
# PHASE1_MODEL=random_forest if wanted.
DEFAULT_ALGO = os.getenv("PHASE1_MODEL", "ridge")

# Minimum distinct images before a retrain is worth doing at all. Below 2 there is
# no cross-validation to run and, honestly, nothing to learn — but note the
# "accuracy doesn't matter" stance: we still FIT and SERVE a model on whatever
# exists, we just can't report an honest generalisation number for it.
MIN_IMAGES_TO_FIT = int(os.getenv("PHASE1_MIN_IMAGES", "2"))

# Keep this many recent artifact files on disk (plus always the current one). Every
# train writes a new .joblib; without pruning the model volume grows forever. The
# ml_models rows are kept regardless — only the (large) files are removed.
KEEP_ARTIFACTS = int(os.getenv("PHASE1_KEEP_ARTIFACTS", "5"))


def _log_extraction(conn, reports, session_ids: list[str] | None) -> None:
    """
    Say why epochs were dropped, and which timeline the data came from.

    build_dataset has always produced an ExtractionReport per session; train.py used to
    assign it to `_` and throw it away. So the one place that could explain a low yield
    — dead electrodes, gap-spanning windows, unlabelled or too-noisy images — reported
    nothing, and diagnosing a thin training set meant re-running the extraction by hand.

    Aggregated rather than per-session: a weekly cron over dozens of sessions should not
    emit dozens of log blocks, but it must not stay silent either.
    """
    if not reports:
        return

    agg = {
        "events": sum(r.events_total for r in reports),
        "kept": sum(r.epochs_kept for r in reports),
        "no_label": sum(r.events_no_label for r in reports),
        "noisy_label": sum(r.events_label_too_noisy for r in reports),
        "too_short": sum(r.events_too_short for r in reports),
        "flat": sum(r.epochs_flat_channel for r in reports),
        "artefact": sum(r.epochs_artefact for r in reports),
        "gap": sum(r.epochs_gap for r in reports),
    }
    log.info(
        "Extraction over %d session(s): %d epochs kept from %d image events. "
        "Events skipped — %d unlabelled, %d label too noisy, %d too short. "
        "Epochs dropped — %d flat channel, %d artefact, %d spanning an EEG gap.",
        len(reports), agg["kept"], agg["events"],
        agg["no_label"], agg["noisy_label"], agg["too_short"],
        agg["flat"], agg["artefact"], agg["gap"],
    )

    dead = sorted({ch for r in reports for ch in r.dead_channels})
    if dead:
        log.warning(
            "Dead electrodes in this training set: %s. Asymmetry features involving "
            "them are noise, not signal.", dead,
        )

    # Which timeline produced this data — see queries.MIN_TIMELINE_VERSION.
    try:
        ids = session_ids or [str(r.session_id) for r in reports]
        mix = queries.fetch_timeline_version_mix(conn, [str(s) for s in ids])
        if mix:
            log.info("Timeline versions in training set: %s (1 = pre-fix compressed, 2 = honest gaps).", mix)
        if len(mix) > 1:
            log.warning(
                "Training set MIXES timeline versions %s. Version-1 sessions carry event "
                "alignment up to 3 s out, so this model is fitted partly on mislabelled "
                "epochs and its CV score describes neither population cleanly. Set "
                "PHASE1_MIN_TIMELINE_VERSION=2 once enough post-fix sessions exist.",
                sorted(mix),
            )
    except Exception:
        # Diagnostics must never break a training run.
        log.debug("Could not read timeline version mix.", exc_info=True)


def _empty_metrics() -> tuple[dict, dict]:
    nan = {"valence": None, "arousal": None}
    return {"r2": dict(nan), "mae": dict(nan)}, {"r2": dict(nan)}


def _has_new_data(current: dict | None, n_epochs: int, n_sessions: int) -> bool:
    """
    Has anything actually changed since the current model was trained? The weekly
    cron fires whether or not new sessions arrived; retraining on identical data
    just mints a redundant version and artifact every week. Grew if there are more
    epochs or more sessions than the model in service was trained on. (A manual
    train bypasses this — see `force`.)
    """
    if current is None:
        return True
    return (n_epochs > (current.get("n_epochs") or 0)
            or n_sessions > (current.get("n_sessions") or 0))


def _should_promote(cv: dict, null: dict, current: dict | None,
                    client_id: str | None = None) -> bool:
    """
    Decide whether a freshly trained model should become the one inference serves.

    PERSONAL MODELS ALWAYS PROMOTE (client_id is not None). A technician asked for
    this specific model over these specific sessions; quietly declining to serve it
    would look broken, and the honest score is shown next to it either way. The gate
    below exists to stop an UNATTENDED weekly retrain silently replacing a good
    population model with a worse one — a risk a deliberate, attended action does
    not carry.

    The gate exists to stop a routine retrain from silently REPLACING a good model
    with a worse one. The rules, in order:

      • No current model → promote. Inference must have something to serve, and a
        meaningless-but-real model is explicitly acceptable for Phase 1.
      • Neither the new model nor the incumbent could be cross-validated (too few
        distinct images to hold any out) → promote the newer one. There is no honest
        score to protect, and this keeps the retrain→promote→predict flow visibly
        working in the current tiny-data regime.
      • New model can't be scored but the incumbent could → keep the incumbent. Don't
        displace a model with a real score using one that has none.
      • New model IS scored → it must clear the predict-the-mean null on BOTH targets
        and not score below a scored incumbent. Otherwise keep the incumbent.
    """
    if client_id is not None:
        return True

    if current is None:
        return True

    v, a = cv["r2"]["valence"], cv["r2"]["arousal"]
    cur_v, cur_a = current.get("cv_r2_valence"), current.get("cv_r2_arousal")
    new_scored = v is not None and a is not None
    cur_scored = cur_v is not None and cur_a is not None

    if not new_scored:
        return not cur_scored  # promote only if the incumbent is unscored too

    nv, na = null["r2"]["valence"], null["r2"]["arousal"]
    if not (v > nv and a > na):
        return False           # no signal over the trivial baseline
    if cur_scored and (v + a) < (cur_v + cur_a):
        return False           # would regress a scored incumbent
    return True


def _prune_artifacts(conn, keep: int = KEEP_ARTIFACTS,
                     client_id: str | None = None) -> int:
    """
    Delete old artifact files, keeping the newest `keep` versions plus whichever is
    current. ml_models rows are left intact (they carry the metric history); only the
    files are removed. File deletes are not transactional, but they only ever touch
    non-current, superseded artifacts, so a rollback after this is harmless.

    ⚠ Pruning is SCOPED to the model's owner. An unscoped "keep the newest 5" would,
    the moment a few clients had trained personal models, delete other clients'
    artifacts while their ml_models rows still pointed at them — inference would then
    fail to load a model the registry insists is current.
    """
    rows = phase1_store.model_artifacts(conn, client_id=client_id, scoped=True)
    protected = {
        r["artifact_path"]
        for i, r in enumerate(rows)
        if i < keep or r["is_current"]
    }
    removed = 0
    for r in rows:
        path = r["artifact_path"]
        if not path or path in protected:
            continue
        try:
            if os.path.exists(path):
                os.remove(path)
                removed += 1
        except OSError:
            log.warning("Could not remove old artifact %s", path, exc_info=True)
    if removed:
        log.info("Pruned %d superseded Phase 1 artifact file(s).", removed)
    return removed


def train_and_save(
    conn,
    cfg: Phase1Config = DEFAULT,
    algo: str = DEFAULT_ALGO,
    force: bool = False,
    client_id: str | None = None,
    session_ids: list[str] | None = None,
) -> dict | None:
    """
    Train, persist, and register one model. Returns a summary dict, or None if the
    run was skipped (not enough data, or — for the automatic cron — no new data
    since the current model).

    SCOPE:
      client_id=None  → the POPULATION model, fitted across every client's sessions.
                        This is the weekly cron, and what a new client is served.
      client_id set   → that client's PERSONAL model. EEG is individualistic enough
                        that a model fitted to one person's own recordings does not
                        have to survive between-subject variation at all.

      session_ids restricts the fit to an explicit list — the technician's chosen
      sessions. Omitted, a personal train uses all of that client's completed
      sessions. The chosen list is recorded against the model (migration 012) so a
      hand-picked training set stays auditable.

    ⚠ The honest sample size is the number of DISTINCT IMAGES, not sessions or
    epochs. Repeat sessions over the same stimulus set add repeated measurements of
    the same labels, not new ones, so a personal model is capped by how many
    different images that client has ever been shown.

    `force` (set by the manual /train endpoint and the CLI) bypasses the no-new-data
    guard so an operator can always retrain on demand. For a POPULATION model it does
    not override the promotion gate; a personal model always promotes by design.

    Does not commit — the caller owns the transaction (so a failed file write or DB
    insert rolls back cleanly). The artifact file is written before the DB row; a
    rolled-back transaction can leave an unreferenced .joblib on disk, which is
    harmless and gets swept by the next successful train's pruning.
    """
    if session_ids is None and client_id is not None:
        session_ids = queries.fetch_client_session_ids(conn, client_id)
        if not session_ids:
            log.info("No completed sessions for client %s — nothing to train.", client_id)
            return None

    X, y, groups, sessions, reports = build_dataset(conn, session_ids, cfg, verbose=False)
    _log_extraction(conn, reports, session_ids)
    n_epochs = int(X.shape[0])
    n_images = int(len(np.unique(groups))) if n_epochs else 0
    n_sessions = int(len(np.unique(sessions))) if n_epochs else 0

    if n_epochs == 0 or n_images < MIN_IMAGES_TO_FIT:
        log.info(
            "Phase 1 training skipped for %s: %d epochs from %d distinct images "
            "(need >= %d images).",
            f"client {client_id}" if client_id else "population",
            n_epochs, n_images, MIN_IMAGES_TO_FIT,
        )
        return None

    current = phase1_store.current_model(conn, client_id)
    if not force and not _has_new_data(current, n_epochs, n_sessions):
        log.info(
            "Phase 1 retrain skipped: no new data since model v%s "
            "(%d epochs / %d sessions unchanged).",
            current.get("model_version"), n_epochs, n_sessions,
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

    # Promotion gate: only serve this model if it doesn't regress the one in service.
    # A personal model bypasses this — see _should_promote.
    make_current = _should_promote(cv, null, current, client_id)

    version = phase1_store.insert_model(
        conn, algo=algo, artifact_path=path,
        n_epochs=n_epochs, n_distinct_images=n_images, n_sessions=n_sessions,
        cv=cv, null=null, make_current=make_current,
        client_id=client_id,
        session_ids=[str(s) for s in np.unique(sessions)] if n_epochs else session_ids,
    )

    # Housekeeping: drop superseded artifact files within this model's own scope.
    _prune_artifacts(conn, client_id=client_id)

    log.info(
        "Trained Phase 1 %s model v%d (%s) on %d epochs / %d images / %d sessions — %s.",
        f"personal (client {client_id})" if client_id else "population",
        version, algo, n_epochs, n_images, n_sessions,
        "promoted to current" if make_current
        else f"kept as candidate (current v{current.get('model_version')} retained)",
    )
    return {
        "model_version": version,
        "algo": algo,
        "client_id": client_id,
        "n_epochs": n_epochs,
        "n_distinct_images": n_images,
        "n_sessions": n_sessions,
        "cv": cv,
        "null": null,
        "artifact_path": path,
        "is_current": make_current,
    }
