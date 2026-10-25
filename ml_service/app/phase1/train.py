"""
phase1/train.py

Fit one GROUP's Phase 1 valence/arousal model, persist it as a joblib artifact, and
register it in ml_models (migration 025). A technician puts clients into a named
group; the model pools each member's latest labelled session and adds the member's
BFI-2 domain scores as extra inputs. The algorithm is a random forest.

Training is OFFLINE and OCCASIONAL — started by a technician (or the operator CLI)
for one group at a time — never per-session. See docs/ARCHITECTURE.md §6.
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
from app.data_access.queries import BFI_DOMAINS

log = logging.getLogger(__name__)

# Group models are random forests (21 Oct 2026 decision: RF won the production
# benchmark, and ridge/mlp blew up on small clients).
ALGO = "random_forest"

# Minimum distinct images before a model is worth fitting at all. Below 2 there is
# nothing to hold out and nothing to learn.
MIN_IMAGES_TO_FIT = int(os.getenv("PHASE1_MIN_IMAGES", "2"))

# A group model is scored by holding one person out, so it needs at least two people
# who can actually contribute (a trainable session and a complete BFI-2).
MIN_PEOPLE = 2

# A member whose latest session yields fewer usable 2 s epochs than this is left out:
# a handful of windows cannot represent a person, and per-session z-scoring is noise
# on so few rows (one real member's session once yielded 2).
MIN_MEMBER_EPOCHS = int(os.getenv("PHASE1_MIN_MEMBER_EPOCHS", "10"))

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

    Aggregated rather than per-session: a train over dozens of sessions should not
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


def _prune_artifacts(conn, group_id: str, keep: int = KEEP_ARTIFACTS) -> int:
    """
    Delete old artifact files, keeping the newest `keep` versions plus whichever is
    current. ml_models rows are left intact (they carry the metric history); only the
    files are removed. File deletes are not transactional, but they only ever touch
    non-current, superseded artifacts, so a rollback after this is harmless.

    ⚠ Pruning is SCOPED to the model's group. An unscoped "keep the newest 5" would,
    the moment a few groups had trained models, delete other groups' artifacts while
    their ml_models rows still pointed at them — inference would then fail to load a
    model the registry insists is current.
    """
    rows = phase1_store.model_artifacts(conn, group_id)
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


def bfi_vector(bfi: dict) -> np.ndarray:
    """A BFI dict from queries.fetch_client_bfi as the model's extra input columns."""
    return np.array([bfi[d] for d in BFI_DOMAINS], dtype=np.float64)


def bfi_feature_names() -> list[str]:
    return [f"bfi_{d}" for d in BFI_DOMAINS]


def resolve_members(conn, group_id: str) -> tuple[list[dict], list[dict]]:
    """
    Split a group's members into those who can contribute and those who cannot.

    A member contributes their latest trainable session (queries.
    fetch_latest_training_sessions) and their BFI-2 domain scores (that session's own
    BFI-2 when complete, else their latest complete one). Returns (usable, skipped):
    usable rows carry client_id, client_name, session_id, start_time, bfi; skipped
    rows carry client_id, client_name and a plain-language reason.
    """
    members = queries.fetch_group_members(conn, group_id)
    latest = queries.fetch_latest_training_sessions(conn, [m["client_id"] for m in members])
    usable, skipped = [], []
    for m in members:
        sess = latest.get(m["client_id"])
        if not sess:
            skipped.append({**m, "reason": (
                f"no completed session with EEG and at least "
                f"{queries.MIN_SESSION_LABELLED_IMAGES} labelled images")})
            continue
        bfi = queries.fetch_client_bfi(conn, m["client_id"], sess["session_id"])
        if not bfi:
            skipped.append({**m, "reason": "no complete BFI-2 questionnaire"})
            continue
        usable.append({**m, "session_id": sess["session_id"],
                       "start_time": sess["start_time"], "bfi": bfi})
    return usable, skipped


def train_group_and_save(
    conn,
    group_id: str,
    cfg: Phase1Config = DEFAULT,
) -> dict:
    """
    Train, persist, and register one group's model, and make it the group's current one.

    Always returns a summary dict. {"trained": False, "message", "skipped"} when there is
    not enough to fit (fewer than MIN_PEOPLE usable members, or too few images); else
    {"trained": True, ...} with the model version, who contributed which session, who
    was left out and why, and the cross-validated scores with and without BFI.

    Inputs per epoch: the EEG features z-scored within their own session (exactly what
    inference does to a new session), then the member's five BFI-2 domain means. BFI is
    appended AFTER the per-session z-scoring: it is constant within a session, so
    z-scoring it there would turn every BFI column into zeros.

    ⚠ The honest sample size is the number of DISTINCT IMAGES, and today every member
    saw the same OASIS set, so pooling people adds repetitions of the same labels, not
    new ones. The score therefore holds out both the person and their test images (see
    evaluate.cross_validate_people).

    Does not commit — the caller owns the transaction (so a failed file write or DB
    insert rolls back cleanly). The artifact file is written before the DB row; a
    rolled-back transaction can leave an unreferenced .joblib on disk, which is
    harmless and gets swept by the next successful train's pruning.
    """
    usable, skipped = resolve_members(conn, group_id)
    if len(usable) < MIN_PEOPLE:
        return {"trained": False, "skipped": skipped, "message": (
            f"Not enough members can contribute yet: {len(usable)} of the "
            f"{len(usable) + len(skipped)} member(s) have a trainable session and a "
            f"complete BFI-2, and a group model needs at least {MIN_PEOPLE}.")}

    session_ids = [m["session_id"] for m in usable]
    X, y, images, sessions, reports = build_dataset(conn, session_ids, cfg, verbose=False)
    _log_extraction(conn, reports, session_ids)

    by_session = {m["session_id"]: m for m in usable}
    session_str = np.array([str(sid) for sid in sessions], dtype=object)
    for m in list(usable):
        n = int((session_str == m["session_id"]).sum())
        if n < MIN_MEMBER_EPOCHS:
            usable.remove(m)
            skipped.append({"client_id": m["client_id"], "client_name": m["client_name"],
                            "reason": f"their latest session produced only {n} usable EEG "
                                      f"epoch(s), fewer than {MIN_MEMBER_EPOCHS} (e.g. a dead "
                                      f"electrode or dropped connection)"})
    keep = np.isin(session_str, [m["session_id"] for m in usable])
    X, y, images, sessions = X[keep], y[keep], images[keep], sessions[keep]

    n_epochs = int(X.shape[0])
    n_images = int(len(np.unique(images))) if n_epochs else 0
    if len(usable) < MIN_PEOPLE or n_images < MIN_IMAGES_TO_FIT:
        return {"trained": False, "skipped": skipped, "message": (
            f"Not enough usable EEG: {len(usable)} member(s) and {n_images} distinct "
            f"labelled image(s) remain after quality checks (need {MIN_PEOPLE} and "
            f"{MIN_IMAGES_TO_FIT}).")}

    people = np.array([by_session[str(sid)]["client_id"] for sid in sessions], dtype=object)
    bfi = np.vstack([bfi_vector(by_session[str(sid)]["bfi"]) for sid in sessions])
    Xn = evaluate.per_session_zscore(X, sessions)

    model = evaluate.make_models()[ALGO]
    res = evaluate.cross_validate_people(Xn, bfi, y, images, people, model)
    cv = {"r2": res.r2, "mae": res.mae}
    cv_no_bfi = {"r2": res.r2_no_bfi, "mae": res.mae_no_bfi}
    null = {"r2": res.null_r2, "mae": res.null_mae}

    final = evaluate.make_models()[ALGO]
    final.fit(np.hstack([Xn, bfi]), y)

    bundle = {
        "model": final,
        "algo": ALGO,
        "uses_bfi": True,
        "bfi_domains": list(BFI_DOMAINS),
        "feature_names": feature_names() + bfi_feature_names(),
        "targets": list(evaluate.TARGETS),
        "epoch_s": cfg.epoch_s,
        "step_s": cfg.step_s,
    }

    os.makedirs(settings.MODEL_DIR, exist_ok=True)
    fname = f"phase1_group_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}_{ALGO}.joblib"
    path = os.path.join(settings.MODEL_DIR, fname)
    joblib.dump(bundle, path)

    version = phase1_store.insert_model(
        conn, group_id=group_id, algo=ALGO, artifact_path=path,
        n_epochs=n_epochs, n_distinct_images=n_images, n_sessions=len(usable),
        n_clients=len(usable), cv=cv, cv_no_bfi=cv_no_bfi, null=null,
        members=[{"client_id": m["client_id"], "session_id": m["session_id"]} for m in usable],
    )

    _prune_artifacts(conn, group_id)

    log.info(
        "Trained group model v%d for group %s on %d people / %d epochs / %d images.",
        version, group_id, len(usable), n_epochs, n_images,
    )
    return {
        "trained": True,
        "message": f"Trained on {len(usable)} member(s)' latest sessions.",
        "model_version": version,
        "algo": ALGO,
        "group_id": group_id,
        "n_clients": len(usable),
        "n_epochs": n_epochs,
        "n_distinct_images": n_images,
        "n_folds": res.n_folds,
        "members": [{"client_id": m["client_id"], "client_name": m["client_name"],
                     "session_id": m["session_id"]} for m in usable],
        "skipped": skipped,
        "cv": cv,
        "cv_no_bfi": cv_no_bfi,
        "null": null,
        "artifact_path": path,
    }
