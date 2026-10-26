"""
phase1/evaluate.py

Cross-validation for EEG -> valence/arousal, and the leakage guard that makes the
numbers mean anything.

THE LEAKAGE PROBLEM
-------------------
Every epoch cut from one image carries that image's label, and consecutive epochs
overlap heavily (2 s window, 0.5 s step -> adjacent epochs share 75% of their
samples). So the ~17 epochs from a single image are near-duplicate rows with an
identical target.

Split those rows at random and near-duplicates land on both sides of the split.
The model does not have to learn "what does this brain response mean" — it only
has to recognise "I have seen this exact stretch of EEG before, it was a 5.2".
That scores beautifully and predicts nothing about a new image.

The fix is not optional: fold assignment is grouped BY IMAGE, so every epoch from
an image is on the same side of every split. `demonstrate_leakage()` measures the
size of the illusion on your actual data by running both ways.

WHAT A REAL RESULT LOOKS LIKE
----------------------------
Always against the null. A model that ignores the EEG and predicts the training
mean has R² ≈ 0 on held-out images. If the grouped R² is not clearly above that,
there is no signal — and reporting a raw correlation without the null is how
people talk themselves into believing there is.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from sklearn.base import clone
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.model_selection import GroupKFold, KFold
from sklearn.metrics import mean_absolute_error, r2_score

TARGETS = ("valence", "arousal")


@dataclass
class Result:
    model: str
    split: str                  # "grouped-by-image" | "random (LEAKY)"
    n_epochs: int
    n_images: int
    r2: dict                    # target -> R² on held-out data
    mae: dict                   # target -> mean absolute error (rating points)
    r: dict                     # target -> Pearson correlation
    null_r2: dict               # target -> R² of the predict-the-mean baseline
    null_mae: dict

    def report(self) -> str:
        lines = [
            f"{self.model}  [{self.split}]  "
            f"{self.n_epochs} epochs from {self.n_images} images",
        ]
        for t in TARGETS:
            lines.append(
                f"    {t:<8} R²={self.r2[t]:+.3f}  MAE={self.mae[t]:.3f}  "
                f"r={self.r[t]:+.3f}   "
                f"| null: R²={self.null_r2[t]:+.3f} MAE={self.null_mae[t]:.3f}"
            )
        return "\n".join(lines)

    def beats_null(self) -> bool:
        """A result is only interesting if it beats predict-the-mean on both targets."""
        return all(self.r2[t] > self.null_r2[t] for t in TARGETS)


def make_models() -> dict:
    """
    Classical models only. With a few hundred distinct images (and, under the
    client's fixed-24 protocol, possibly only 24 distinct LABELS), a deep network
    has orders of magnitude more capacity than the data can constrain — it would
    memorise, and the grouped CV would simply report that it had.
    """
    return {
        "ridge": Ridge(alpha=1.0),
        "random_forest": RandomForestRegressor(
            n_estimators=300, min_samples_leaf=2, random_state=0, n_jobs=-1,
        ),
    }


def _per_session_zscore(
    X: np.ndarray,
    sessions: np.ndarray,
    fit_mask: np.ndarray,
) -> np.ndarray:
    """
    Z-score each session's features against that session's own statistics.

    Absolute EEG amplitude is dominated by cap fit, gel and skin impedance, which
    change between sessions and carry no information about the stimulus. Left
    alone, a model can score well by identifying the session and predicting its
    mean valence — which collapses the moment it meets a new participant.

    Statistics are taken from TRAINING rows of that session only. This uses no
    labels, and mirrors inference, where a new session is normalised against its
    own EEG.
    """
    Xn = X.copy()
    for s in np.unique(sessions):
        in_session = sessions == s
        fit_rows = in_session & fit_mask
        # A session wholly inside the test fold has no training rows to fit on;
        # fall back to its own rows. Still label-free, so still not leakage.
        src = X[fit_rows] if fit_rows.sum() >= 2 else X[in_session]
        mu = src.mean(axis=0)
        sd = src.std(axis=0)
        sd[sd < 1e-9] = 1.0          # a constant feature carries no information
        Xn[in_session] = (X[in_session] - mu) / sd
    return Xn


def per_session_zscore(X: np.ndarray, sessions: np.ndarray) -> np.ndarray:
    """
    Normalise every row against its own session's statistics — the transform used
    when fitting the FINAL model and, identically, at inference (one session
    normalised against itself). Same maths as the CV path, with the fit mask set to
    every row, which is leakage-free because the transform never touches the labels.
    """
    return _per_session_zscore(X, sessions, np.ones(len(X), dtype=bool))


def cross_validate(
    X: np.ndarray,
    y: np.ndarray,
    groups: np.ndarray,
    sessions: np.ndarray,
    model,
    model_name: str,
    n_splits: int = 5,
    grouped: bool = True,
    per_session_zscore: bool = True,
) -> Result:
    """
    Out-of-fold prediction under either grouped (honest) or random (leaky) splits.

    grouped=True is the only setting whose numbers should ever be reported. The
    leaky path exists so demonstrate_leakage() can show what the dishonest number
    would have been.
    """
    n_images = len(np.unique(groups))
    n_splits = min(n_splits, n_images) if grouped else n_splits
    if grouped and n_splits < 2:
        raise ValueError(
            f"Need at least 2 distinct images to group folds by image; got {n_images}. "
            "With a single image there is nothing to generalise to."
        )

    splitter = (GroupKFold(n_splits=n_splits) if grouped
                else KFold(n_splits=n_splits, shuffle=True, random_state=0))
    split_iter = (splitter.split(X, y, groups) if grouped
                  else splitter.split(X, y))

    oof = np.full_like(y, np.nan, dtype=np.float64)
    null = np.full_like(y, np.nan, dtype=np.float64)

    for train_idx, test_idx in split_iter:
        fit_mask = np.zeros(len(X), dtype=bool)
        fit_mask[train_idx] = True

        Xs = _per_session_zscore(X, sessions, fit_mask) if per_session_zscore else X

        m = clone(model)
        m.fit(Xs[train_idx], y[train_idx])
        oof[test_idx] = m.predict(Xs[test_idx])

        # The null: ignore the EEG entirely, predict the TRAINING mean. Its R² on
        # held-out images is the bar every real model has to clear.
        null[test_idx] = y[train_idx].mean(axis=0)

    r2, mae, r, null_r2, null_mae = {}, {}, {}, {}, {}
    for i, t in enumerate(TARGETS):
        r2[t] = float(r2_score(y[:, i], oof[:, i]))
        mae[t] = float(mean_absolute_error(y[:, i], oof[:, i]))
        # Pearson r is undefined if the model emitted a constant.
        sd_pred = float(np.std(oof[:, i]))
        r[t] = (float(np.corrcoef(y[:, i], oof[:, i])[0, 1])
                if sd_pred > 1e-9 else float("nan"))
        null_r2[t] = float(r2_score(y[:, i], null[:, i]))
        null_mae[t] = float(mean_absolute_error(y[:, i], null[:, i]))

    return Result(
        model=model_name,
        split="grouped-by-image" if grouped else "random (LEAKY)",
        n_epochs=len(X),
        n_images=n_images,
        r2=r2, mae=mae, r=r, null_r2=null_r2, null_mae=null_mae,
    )


def demonstrate_leakage(
    X: np.ndarray,
    y: np.ndarray,
    groups: np.ndarray,
    sessions: np.ndarray,
    model=None,
    model_name: str = "ridge",
) -> tuple[Result, Result]:
    """
    Run the SAME model both ways and return (honest, leaky).

    The gap between them is the size of the illusion a random split would have
    handed you on this exact data. Run it once on real data and keep the number:
    it is the most persuasive argument available for why the grouped split is not
    negotiable, and it is far more convincing than the assertion.
    """
    model = model or Ridge(alpha=1.0)
    honest = cross_validate(X, y, groups, sessions, model, model_name, grouped=True)
    leaky = cross_validate(X, y, groups, sessions, model, model_name, grouped=False)
    return honest, leaky


def evaluate_all(
    X: np.ndarray,
    y: np.ndarray,
    groups: np.ndarray,
    sessions: np.ndarray,
    n_splits: int = 5,
) -> list[Result]:
    """Grouped CV for every model. These are the only numbers fit to report."""
    return [
        cross_validate(X, y, groups, sessions, m, name, n_splits=n_splits, grouped=True)
        for name, m in make_models().items()
    ]


# ── Group models: leave one PERSON out ─────────────────────────────────────────

@dataclass
class GroupResult:
    """Cross-validated score of a group model, with and without the BFI inputs."""
    n_people: int
    n_epochs: int
    n_images: int
    n_folds: int
    r2: dict                    # with BFI
    mae: dict
    r2_no_bfi: dict             # same splits, BFI columns left out
    mae_no_bfi: dict
    null_r2: dict               # predict-the-training-mean on the same splits
    null_mae: dict
    # The with-BFI score of each person on their own held-out epochs, keyed by person:
    # {"n_epochs", "r2": {...}, "mae": {...}}. How well the group's model would have
    # served each member had they been new; the range a newcomer is placed in.
    per_person: dict = field(default_factory=dict)


def cross_validate_people(
    Xn: np.ndarray,
    bfi: np.ndarray,
    y: np.ndarray,
    images: np.ndarray,
    people: np.ndarray,
    model,
    n_image_splits: int = 5,
) -> GroupResult:
    """
    The honest score for a model meant to serve people it was not trained on.

    Every test fold is ONE person's epochs for a block of images, and the model is
    trained on the OTHER people's epochs for the OTHER images. Holding the person out
    is what a group model has to survive (EEG differs a lot between people). Holding
    their test images out of training as well matters here because every member saw the
    same OASIS set: without it, the model could score by recognising an image it had
    already seen in someone else's EEG, which says nothing about a new image.

    Xn is the EEG features already z-scored per session (label-free, the same transform
    inference applies), and bfi the matching per-row BFI-2 domain means. Both variants
    use identical splits so their difference is the effect of BFI alone.
    """
    person_ids = np.unique(people)
    n_images = len(np.unique(images))
    if len(person_ids) < 2:
        raise ValueError("Need at least 2 people to hold one out.")
    n_splits = min(n_image_splits, n_images)
    if n_splits < 2:
        raise ValueError(f"Need at least 2 distinct images; got {n_images}.")

    X_bfi = np.hstack([Xn, bfi])
    oof = np.full_like(y, np.nan, dtype=np.float64)
    oof_no = np.full_like(y, np.nan, dtype=np.float64)
    null = np.full_like(y, np.nan, dtype=np.float64)

    image_folds = list(GroupKFold(n_splits=n_splits).split(Xn, y, images))
    n_folds = 0
    for person in person_ids:
        is_person = people == person
        for _, fold_idx in image_folds:
            fold_images = np.unique(images[fold_idx])
            in_fold = np.isin(images, fold_images)
            test = is_person & in_fold
            train = ~is_person & ~in_fold
            if not test.any() or train.sum() < 2:
                continue
            n_folds += 1
            m = clone(model)
            m.fit(X_bfi[train], y[train])
            oof[test] = m.predict(X_bfi[test])
            m_no = clone(model)
            m_no.fit(Xn[train], y[train])
            oof_no[test] = m_no.predict(Xn[test])
            null[test] = y[train].mean(axis=0)

    scored = ~np.isnan(oof[:, 0])
    if scored.sum() < 2:
        raise ValueError("No fold had both training and test data.")

    def metrics(pred):
        r2, mae = {}, {}
        for i, t in enumerate(TARGETS):
            r2[t] = float(r2_score(y[scored, i], pred[scored, i]))
            mae[t] = float(mean_absolute_error(y[scored, i], pred[scored, i]))
        return r2, mae

    r2, mae = metrics(oof)
    r2_no, mae_no = metrics(oof_no)
    null_r2, null_mae = metrics(null)
    per_person = {}
    for person in person_ids:
        rows = scored & (people == person)
        if rows.sum() >= 2:
            per_person[person] = {"n_epochs": int(rows.sum()),
                                  **score_predictions(y[rows], oof[rows])}
    return GroupResult(
        n_people=len(person_ids), n_epochs=int(scored.sum()), n_images=n_images,
        n_folds=n_folds, r2=r2, mae=mae, r2_no_bfi=r2_no, mae_no_bfi=mae_no,
        null_r2=null_r2, null_mae=null_mae, per_person=per_person,
    )


def score_predictions(y: np.ndarray, pred: np.ndarray) -> dict:
    """{"r2": {...}, "mae": {...}} keyed by target, for one set of predictions."""
    return {
        "r2": {t: float(r2_score(y[:, i], pred[:, i])) for i, t in enumerate(TARGETS)},
        "mae": {t: float(mean_absolute_error(y[:, i], pred[:, i])) for i, t in enumerate(TARGETS)},
    }
