"""
phase1/group_fit.py

How a client compares with a trained group (26 Oct 2026). Three separate comparisons,
each answering a different question:

  personality   Is their BFI-2 profile like the group's?          (statistics)
  eeg_profile   Does their brain activity look like the group's?  (statistics)
  response      Does the group's EEG -> emotion link hold for them? (the group's model)

Every comparison is placed in the same frame: a client's score only means something
next to the members' own scores, so each member is also scored against the REST of the
group (left out, exactly as the newcomer is), and the client is placed in that range.

⚠ Descriptive only. "Within the group's range" says the client resembles the group on
that measure; it is not a prediction of how well they would do in it, and with the
current data (few people, one image set, unproven signal quality) none of the three is
reliable yet. The wording on the page is kept neutral for the same reason.
"""

from __future__ import annotations

import logging

import numpy as np
from sklearn.base import clone
from sklearn.model_selection import GroupKFold

from app.data_access import phase1_store, queries
from app.data_access.queries import BFI_DOMAINS, FFT_BANDS, FFT_CHANNELS
from app.phase1 import evaluate, train
from app.phase1.config import DEFAULT, Phase1Config
from app.phase1.dataset import build_dataset

log = logging.getLogger(__name__)

# The smallest spread a comparison will divide by. With a handful of members, two of them
# can share a score exactly (the BFI test data is nearly all 3s), and a zero spread would
# turn any difference at all into an infinite distance. Floors are a small but real
# difference on each scale: a quarter of a point on the 1-5 BFI-2 scale, one percentage
# point of a channel's power.
BFI_SD_FLOOR = 0.25
EEG_SD_FLOOR = 1.0

# Band shares are only compared when enough of the session has band powers.
MIN_EEG_WINDOWS = 20

# Placing a client by distance needs each member measured against at least 2 others:
# against a single other person there is no spread at all, every member's distance is
# set by the floor alone, and the range comes out arbitrarily wide. Below this the
# comparison with the group average is still shown, without a placement.
MIN_MEMBERS_TO_PLACE = 3


class FitError(Exception):
    """A comparison that cannot run at all; `status` is the HTTP status to answer with."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ── Shared scoring ───────────────────────────────────────────────────────────────

def distance(values: np.ndarray, ref: np.ndarray, sd_floor: float) -> tuple[float, np.ndarray]:
    """
    How far `values` sits from the reference rows `ref` (members x features), as the
    root-mean-square of its per-feature z-scores: "typically this many spreads from the
    group". Returns (distance, z per feature).
    """
    mean = ref.mean(axis=0)
    sd = np.maximum(ref.std(axis=0), sd_floor)
    z = (values - mean) / sd
    return float(np.sqrt(np.mean(z ** 2))), z


def leave_one_out_distances(ref: np.ndarray, sd_floor: float) -> list[float]:
    """Each member's distance from the OTHER members — the range a newcomer is placed in."""
    out = []
    for i in range(len(ref)):
        others = np.delete(ref, i, axis=0)
        out.append(distance(ref[i], others, sd_floor)[0])
    return out


def placement(score: float, member_scores: list[float]) -> dict:
    """
    Where a score falls among the members' scores; lower is closer to the group (or, for
    the response comparison, a smaller error). within_range: no further out than the
    furthest member.
    """
    return {
        "within_range": bool(score <= max(member_scores)),
        "members_further": int(sum(m > score for m in member_scores)),
        "n_members": len(member_scores),
    }


def _unavailable(reason: str) -> dict:
    return {"available": False, "reason": reason}


def _distance_result(dist: float, ref: np.ndarray, have: list[dict], sd_floor: float) -> dict:
    """The distance, and the members' range with the client's place in it when there are
    enough members to have one (MIN_MEMBERS_TO_PLACE)."""
    if len(have) < MIN_MEMBERS_TO_PLACE:
        return {"distance": dist, "members": [], "placement": None}
    member_d = leave_one_out_distances(ref, sd_floor)
    return {
        "distance": dist,
        "members": [{"client_id": m["client_id"], "client_name": m["client_name"],
                     "distance": d} for m, d in zip(have, member_d)],
        "placement": placement(dist, member_d),
    }


# ── 1. Personality ─────────────────────────────────────────────────────────────

def compare_personality(client_bfi: dict | None, members: list[dict]) -> dict:
    """members: [{client_id, client_name, bfi}] — bfi may be None."""
    if client_bfi is None:
        return _unavailable("This client has no complete BFI-2 questionnaire.")
    have = [m for m in members if m.get("bfi")]
    if len(have) < 2:
        return _unavailable("Fewer than 2 group members have a complete BFI-2.")

    ref = np.array([[m["bfi"][d] for d in BFI_DOMAINS] for m in have])
    vec = np.array([client_bfi[d] for d in BFI_DOMAINS])
    dist, z = distance(vec, ref, BFI_SD_FLOOR)
    mean, sd = ref.mean(axis=0), ref.std(axis=0)
    return {
        "available": True,
        **_distance_result(dist, ref, have, BFI_SD_FLOOR),
        "domains": [
            {"domain": d, "client": float(vec[i]), "group_mean": float(mean[i]),
             "group_sd": float(sd[i]), "z": float(z[i])}
            for i, d in enumerate(BFI_DOMAINS)
        ],
    }


# ── 2. EEG profile ─────────────────────────────────────────────────────────────

def band_shares(powers: np.ndarray) -> np.ndarray | None:
    """
    A session's typical share of each band in each channel's power, in percent, shape
    (channels * bands,). Per window each channel's bands are divided by that channel's
    total, then the median over windows is taken (robust to movement artefacts).

    Shares rather than absolute power: absolute µV² swings with electrode contact and
    headband fit from one recording to the next, which would make the comparison mostly
    about how well the band was seated.
    """
    if powers.shape[0] < MIN_EEG_WINDOWS:
        return None
    total = np.nansum(powers, axis=2, keepdims=True)
    with np.errstate(invalid="ignore", divide="ignore"):
        share = np.where(total > 0, powers / total * 100.0, np.nan)
    med = np.nanmedian(share, axis=0)
    if np.isnan(med).any():
        return None
    return med.reshape(-1)


def compare_eeg_profile(client_shares: np.ndarray | None, members: list[dict]) -> dict:
    """members: [{client_id, client_name, shares}] — shares may be None."""
    if client_shares is None:
        return _unavailable("This client's session has no frequency-band data yet.")
    have = [m for m in members if m.get("shares") is not None]
    if len(have) < 2:
        return _unavailable("Fewer than 2 group members have frequency-band data.")

    ref = np.vstack([m["shares"] for m in have])
    dist, z = distance(client_shares, ref, EEG_SD_FLOOR)
    mean, sd = ref.mean(axis=0), ref.std(axis=0)
    features = [
        {"channel": ch.upper(), "band": b, "client": float(client_shares[k]),
         "group_mean": float(mean[k]), "group_sd": float(sd[k]), "z": float(z[k])}
        for k, (ch, b) in enumerate((c, b) for c in FFT_CHANNELS for b in FFT_BANDS)
    ]
    return {
        "available": True,
        **_distance_result(dist, ref, have, EEG_SD_FLOOR),
        "features": features,
    }


# ── 3. Response (the group's model) ─────────────────────────────────────────────

def score_newcomer(
    Xn_m: np.ndarray, bfi_m: np.ndarray, y_m: np.ndarray, images_m: np.ndarray,
    Xn_c: np.ndarray, bfi_c: np.ndarray, y_c: np.ndarray, images_c: np.ndarray,
    model, n_image_splits: int = 5,
) -> dict:
    """
    Score the group's model on a client outside the group, the same way each member was
    scored in training (evaluate.cross_validate_people): fitted on the members only,
    never on the client, and with the client's test images held out of training.

    Holding the images out matters because everyone saw the same OASIS set. The stored
    model has seen every image's rating, so running it as-is on the client would let it
    score by recognising images and make the client look better than the members did.
    """
    images_all = np.concatenate([images_m, images_c])
    n_splits = min(n_image_splits, len(np.unique(images_all)))
    if n_splits < 2:
        raise ValueError("Need at least 2 distinct images.")

    X_m = np.hstack([Xn_m, bfi_m])
    X_c = np.hstack([Xn_c, bfi_c])
    pred = np.full_like(y_c, np.nan, dtype=np.float64)
    folds = GroupKFold(n_splits=n_splits).split(images_all, groups=images_all)
    for _, fold_idx in folds:
        fold_images = np.unique(images_all[fold_idx])
        test = np.isin(images_c, fold_images)
        train_rows = ~np.isin(images_m, fold_images)
        if not test.any() or train_rows.sum() < 2:
            continue
        m = clone(model)
        m.fit(X_m[train_rows], y_m[train_rows])
        pred[test] = m.predict(X_c[test])

    scored = ~np.isnan(pred[:, 0])
    if scored.sum() < 2:
        raise ValueError("No fold had both training and test data.")
    return {"n_epochs": int(scored.sum()),
            **evaluate.score_predictions(y_c[scored], pred[scored])}


def mean_error(mae: dict) -> float:
    """One number per person for placing them: the mean of their valence and arousal error."""
    return float(np.mean([mae[t] for t in evaluate.TARGETS]))


def compare_response(conn, client_session: dict | None, client_bfi: dict | None,
                     members: list[dict], cfg: Phase1Config) -> dict:
    if client_session is None:
        return _unavailable(
            f"This client has no completed session with EEG and at least "
            f"{queries.MIN_SESSION_LABELLED_IMAGES} labelled images.")
    if client_bfi is None:
        return _unavailable("The group's model uses BFI-2, and this client has no complete "
                            "BFI-2 questionnaire.")
    scored = [m for m in members if m.get("cv_mae_valence") is not None
              and m.get("cv_mae_arousal") is not None]
    if not scored:
        return _unavailable("This model was trained before members' own scores were kept. "
                            "Retrain the group to compare clients with it.")
    if len(scored) < 2:
        return _unavailable("Fewer than 2 members have their own score to compare against.")
    if any(not m.get("bfi") for m in members):
        return _unavailable("A member's BFI-2 is no longer complete, so the group's training "
                            "data cannot be rebuilt.")

    member_sessions = [m["session_id"] for m in members]
    X_m, y_m, img_m, ses_m, _ = build_dataset(conn, member_sessions, cfg, verbose=False)
    X_c, y_c, img_c, ses_c, _ = build_dataset(conn, [client_session["session_id"]], cfg,
                                              verbose=False)
    if len(X_c) < train.MIN_MEMBER_EPOCHS:
        return _unavailable(
            f"This client's latest session produced only {len(X_c)} usable EEG epoch(s), "
            f"fewer than {train.MIN_MEMBER_EPOCHS}.")
    if len(X_m) == 0:
        return _unavailable("The group's training sessions produced no usable EEG.")

    by_session = {m["session_id"]: m for m in members}
    bfi_m = np.vstack([train.bfi_vector(by_session[str(s)]["bfi"]) for s in ses_m])
    bfi_c = np.tile(train.bfi_vector(client_bfi), (len(X_c), 1))
    try:
        res = score_newcomer(
            evaluate.per_session_zscore(X_m, ses_m), bfi_m, y_m, img_m,
            evaluate.per_session_zscore(X_c, ses_c), bfi_c, y_c, img_c,
            evaluate.make_models()[train.ALGO],
        )
    except ValueError as e:
        return _unavailable(f"Could not score this client: {e}")

    member_errors = [mean_error({"valence": m["cv_mae_valence"], "arousal": m["cv_mae_arousal"]})
                     for m in scored]
    err = mean_error(res["mae"])
    return {
        "available": True,
        "n_epochs": res["n_epochs"],
        "r2": res["r2"],
        "mae": res["mae"],
        "error": err,
        "members": [{"client_id": m["client_id"], "client_name": m["client_name"],
                     "error": e, "mae": {"valence": m["cv_mae_valence"],
                                         "arousal": m["cv_mae_arousal"]}}
                    for m, e in zip(scored, member_errors)],
        "placement": placement(err, member_errors),
    }


# ── Entry point ─────────────────────────────────────────────────────────────────

def compare_client(conn, group_id: str, client_id: str, cfg: Phase1Config = DEFAULT) -> dict:
    """
    Compare one client with a group's current model and the members it was trained on.

    Raises FitError(404) without a trained model or client, FitError(400) when the client
    is one of the model's own members (the model has learnt from them, so they cannot be
    compared as a newcomer) or belongs to another clinic.
    """
    group = queries.fetch_group(conn, group_id)
    if group is None:
        raise FitError(404, "Group not found.")
    model = phase1_store.current_model(conn, group_id)
    if model is None:
        raise FitError(404, "This group has no trained model yet. Train it first.")
    client = queries.fetch_client(conn, client_id)
    if client is None:
        raise FitError(404, "Client not found.")
    if client["clinic_id"] != str(group["clinic_id"]):
        raise FitError(400, "The client belongs to a different clinic from the group.")

    members = [
        {**m, "client_id": str(m["client_id"]), "session_id": str(m["session_id"])}
        for m in phase1_store.model_members(conn, int(model["model_version"]))
    ]
    if any(m["client_id"] == client["client_id"] for m in members):
        raise FitError(400, "This client is one of the members the model was trained on, so "
                            "they cannot be compared with it as a newcomer. Their own score "
                            "is in the model details.")

    for m in members:
        m["bfi"] = queries.fetch_client_bfi(conn, m["client_id"], m["session_id"])
        m["shares"] = band_shares(queries.fetch_session_band_powers(conn, m["session_id"]))

    session = queries.fetch_latest_training_sessions(conn, [client["client_id"]]).get(
        client["client_id"])
    client_bfi = queries.fetch_client_bfi(
        conn, client["client_id"], session["session_id"] if session else None)
    client_shares = (band_shares(queries.fetch_session_band_powers(conn, session["session_id"]))
                     if session else None)

    return {
        "group_id": str(group_id),
        "group_name": group["name"],
        "model_version": int(model["model_version"]),
        "client_id": client["client_id"],
        "client_name": client["client_name"],
        "session_id": session["session_id"] if session else None,
        "session_start": session["start_time"] if session else None,
        "personality": compare_personality(client_bfi, members),
        "eeg_profile": (compare_eeg_profile(client_shares, members) if session else
                        _unavailable(f"This client has no completed session with EEG and at "
                                     f"least {queries.MIN_SESSION_LABELLED_IMAGES} labelled "
                                     f"images.")),
        "response": compare_response(conn, session, client_bfi, members, cfg),
    }
