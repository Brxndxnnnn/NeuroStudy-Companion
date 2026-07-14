"""
phase1/dataset.py

Assemble the training matrix across sessions.
"""

from __future__ import annotations

import numpy as np

from app.data_access import queries
from app.phase1 import epochs as ep
from app.phase1 import features as ft
from app.phase1.config import DEFAULT, Phase1Config


def build_dataset(
    conn,
    session_ids: list[str] | None = None,
    cfg: Phase1Config = DEFAULT,
    verbose: bool = True,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, list[ep.ExtractionReport]]:
    """
    Pool labelled epochs across sessions into (X, y, groups, sessions, reports).

    session_ids defaults to every session the BRIDGE has marked 'completed' —
    the only state that guarantees its EEG is fully written (see
    queries.fetch_completed_session_ids).
    """
    session_ids = session_ids or queries.fetch_completed_session_ids(conn)

    all_epochs: list[ep.Epoch] = []
    reports: list[ep.ExtractionReport] = []

    for sid in session_ids:
        epochs, report = ep.extract_session_epochs(conn, sid, cfg)
        all_epochs.extend(epochs)
        reports.append(report)
        if verbose:
            print(report.summary())

    X, y, groups, sessions = ft.build_matrix(all_epochs, cfg)

    if verbose:
        n_img = len(np.unique(groups)) if len(groups) else 0
        print(f"\nDataset: {X.shape[0]} epochs x {X.shape[1]} features, "
              f"{n_img} distinct images, {len(session_ids)} sessions")
        if n_img and n_img < 30:
            print(
                f"⚠ Only {n_img} distinct images. The regression's sample size is the "
                f"number of distinct LABELS, not the number of epochs — {X.shape[0]} "
                f"epochs carrying {n_img} labels is a {n_img}-point regression with "
                f"repeated measurements, not a {X.shape[0]}-point one. Generalisation "
                f"to an unseen image cannot be meaningfully established from this."
            )

    return X, y, groups, sessions, reports
