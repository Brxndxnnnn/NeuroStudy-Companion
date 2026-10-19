"""
phase1/models.py

The registry of algorithms Phase 1 can train and serve. This is the ONE place an
algorithm is added, removed or retuned — evaluate.py, train.py and inference.py only
ever ask for a model by name.

    baseline   ridge
    Tier 1     random_forest, svm, xgboost
    Tier 2     mlp                      (cnn_lstm is not here yet — see below)

THE CONTRACT
------------
Every entry builds a fresh, UNFITTED scikit-learn-style regressor that:
  - takes X [n_epochs, n_features] — the per-session z-scored vector from features.py
  - takes y [n_epochs, 2]          — (valence, arousal), both fitted at once
  - survives sklearn.base.clone(), because cross_validate() clones per fold
  - pickles with joblib, because train.py saves the fitted model in its bundle

Which model is SERVED is not decided here: train.py reads PHASE1_MODEL. A saved
artifact carries its own fitted model, so changing the default never touches a
client's existing model — they keep it until someone retrains them.

WHY THE MODELS ARE SMALL
------------------------
With a few hundred distinct images (and, under the client's fixed-24 protocol,
possibly only 24 distinct LABELS), any flexible model has far more capacity than the
data can constrain. The hyperparameters below lean towards regularisation for that
reason, and the grouped CV in evaluate.py is what reports whether it was enough.

⚠ cnn_lstm does not fit this contract: it learns from the raw epoch signal
[channels, samples], not from the feature vector. It needs its own input path in
train.py and inference.py before it can be registered here.
"""

from __future__ import annotations

from typing import Callable

from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.multioutput import MultiOutputRegressor
from sklearn.neural_network import MLPRegressor
from sklearn.svm import SVR


class ModelUnavailable(RuntimeError):
    """The algorithm is registered, but the library it needs is not installed."""


def _ridge():
    return Ridge(alpha=1.0)


def _random_forest():
    return RandomForestRegressor(
        n_estimators=300, min_samples_leaf=2, random_state=0, n_jobs=-1,
    )


def _svm():
    # SVR predicts a single target, so it is fitted once per target. It is also
    # scale-sensitive; the per-session z-score in evaluate.py is what makes the RBF
    # kernel's single gamma meaningful across 50 features of very different units.
    return MultiOutputRegressor(SVR(kernel="rbf", C=1.0, epsilon=0.1))


def _xgboost():
    # Imported here, not at module top: xgboost is the one heavy optional library,
    # and the service (and every other model) must still work where it is absent.
    try:
        from xgboost import XGBRegressor
    except ImportError as exc:
        raise ModelUnavailable(
            "Model 'xgboost' needs the xgboost package — pip install -r requirements.txt"
        ) from exc
    # Shallow trees, a slow learning rate and row/column subsampling: boosting will
    # happily memorise a few dozen labels if it is allowed deep trees.
    return XGBRegressor(
        n_estimators=300, max_depth=3, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, random_state=0,
    )


def _mlp():
    # One small hidden layer with a strong L2 penalty. early_stopping is left off on
    # purpose: it holds out a RANDOM slice of the training rows, and consecutive
    # epochs of one image are near-duplicates, so that validation score would be
    # leaked and would never tell the network to stop.
    return MLPRegressor(
        hidden_layer_sizes=(32,), alpha=1.0, max_iter=2000, random_state=0,
    )


REGISTRY: dict[str, Callable[[], object]] = {
    "ridge": _ridge,
    "random_forest": _random_forest,
    "svm": _svm,
    "xgboost": _xgboost,
    "mlp": _mlp,
}


def names() -> list[str]:
    """Every registered algorithm name, whether or not its library is installed."""
    return list(REGISTRY)


def build(name: str):
    """
    A fresh, unfitted model by name. Raises ValueError for a name that is not
    registered and ModelUnavailable for one whose library is missing.
    """
    if name not in REGISTRY:
        raise ValueError(f"Unknown model '{name}'. Choices: {names()}")
    return REGISTRY[name]()


def make_models() -> dict:
    """
    One fresh instance of every model that can be built in this environment. A model
    whose library is not installed is left out rather than failing the whole
    comparison.
    """
    out = {}
    for name in REGISTRY:
        try:
            out[name] = build(name)
        except ModelUnavailable:
            continue
    return out
