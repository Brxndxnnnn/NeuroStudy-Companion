"""
phase1/epochs.py

Cut a session's filtered EEG into labelled epochs.

    eeg_filtered_samples  +  events (image windows)  +  images (OASIS labels)
        -> [Epoch(signals, valence, arousal, image_id, ...)]

Each epoch is a fixed-length slice of 4-channel EEG lying entirely inside one
image's on-screen window, labelled with that image's population-normed OASIS
valence and arousal. Every epoch from one image gets the SAME label — which is
the whole reason the training split must be grouped by image (see evaluate.py).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

import numpy as np

from app.core.config import settings
from app.data_access import queries
from app.phase1.config import DEFAULT, Phase1Config

CHANNELS = settings.CHANNELS   # ["fp1", "fp2", "t3", "t4"]


@dataclass
class Epoch:
    """One labelled training row, before feature extraction."""
    session_id: str
    image_id:   str
    event_id:   str
    t_start:    datetime
    t_end:      datetime
    signals:    dict            # {channel -> 1D np.ndarray of µV}
    valence:    float
    arousal:    float
    valence_sd: float
    arousal_sd: float
    oasis_theme: str | None = None


@dataclass
class ExtractionReport:
    """
    Why epochs were dropped. Printed after every extraction — a silent drop is how
    you end up training on a quarter of the data you think you have.
    """
    session_id:            str
    events_total:          int = 0
    events_no_label:       int = 0
    events_label_too_noisy: int = 0
    events_too_short:      int = 0
    epochs_kept:           int = 0
    epochs_flat_channel:   int = 0
    epochs_artefact:       int = 0
    epochs_gap:            int = 0
    dead_channels:         set = field(default_factory=set)

    def summary(self) -> str:
        lines = [
            f"session {self.session_id[:8]}: {self.epochs_kept} epochs kept",
            f"  events: {self.events_total} total, "
            f"{self.events_no_label} unlabelled, "
            f"{self.events_label_too_noisy} label too noisy, "
            f"{self.events_too_short} too short for one epoch",
            f"  epochs dropped: {self.epochs_flat_channel} flat channel, "
            f"{self.epochs_artefact} artefact, {self.epochs_gap} EEG gap",
        ]
        if self.dead_channels:
            lines.append(
                f"  ⚠ DEAD CHANNELS: {sorted(self.dead_channels)} — flat all session. "
                f"Every epoch here is effectively {4 - len(self.dead_channels)}-channel; "
                f"asymmetry features involving them are meaningless."
            )
        return "\n".join(lines)


def _channel_matrix(samples: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    """(times, values[n_samples, 4]) from the fetched rows, in CHANNELS order."""
    times = np.array([s["time"] for s in samples])
    vals = np.column_stack([
        np.array([float(s[ch]) for s in samples], dtype=np.float64)
        for ch in CHANNELS
    ])
    return times, vals


def extract_session_epochs(
    conn,
    session_id: str,
    cfg: Phase1Config = DEFAULT,
    require_label: bool = True,
) -> tuple[list[Epoch], ExtractionReport]:
    """
    Build epochs for one session.

    require_label=True (training): an image event contributes epochs only if its
    image carries an OASIS label within the SD gate; each epoch is labelled with it.

    require_label=False (inference): epochs are cut from EVERY image event, labelled
    or not, and carry NaN valence/arousal. Prediction reads EEG, not labels, so a
    session recorded over unlabelled (even placeholder) images still yields
    predictions — which is why every completed session can populate the Insights tab.

    Returns (epochs, report). An empty list is a normal outcome for a session whose
    electrodes were dead (or, in training mode, whose images carry no OASIS labels) —
    the report says which, rather than leaving you to guess at a silent zero.
    """
    report = ExtractionReport(session_id=session_id)

    samples = queries.fetch_filtered_samples(conn, session_id)
    events = queries.fetch_labelled_image_events(conn, session_id)
    report.events_total = len(events)

    if not samples or not events:
        return [], report

    times, values = _channel_matrix(samples)

    # A whole-session flatness check, so a dead electrode is reported once rather
    # than as hundreds of individually-dropped epochs with no stated cause.
    for ci, ch in enumerate(CHANNELS):
        col = values[:, ci]
        if float(col.max() - col.min()) < cfg.flat_pkpk_uv:
            report.dead_channels.add(ch)

    epochs: list[Epoch] = []
    n_epoch = cfg.epoch_samples
    n_step = cfg.step_samples
    # The bridge writes a uniform 250 Hz timeline, so a run of samples is
    # contiguous iff its time span matches its sample count. Allow a half-sample
    # of slack for µs rounding.
    max_span_s = (n_epoch - 1) / cfg.sample_rate + (0.5 / cfg.sample_rate)

    for ev in events:
        if require_label:
            if ev["valence_mean"] is None or ev["arousal_mean"] is None:
                report.events_no_label += 1
                continue

            # Rater disagreement makes a label unlearnable — exclude rather than
            # train the model to fit noise. SDs may be NULL on legacy rows; treat a
            # missing SD as acceptable rather than silently dropping every image.
            v_sd = ev["valence_sd"]
            a_sd = ev["arousal_sd"]
            if (v_sd is not None and v_sd > cfg.max_label_sd) or \
               (a_sd is not None and a_sd > cfg.max_label_sd):
                report.events_label_too_noisy += 1
                continue
            valence = float(ev["valence_mean"])
            arousal = float(ev["arousal_mean"])
            valence_sd = float(v_sd) if v_sd is not None else float("nan")
            arousal_sd = float(a_sd) if a_sd is not None else float("nan")
        else:
            # Inference: no label needed. The features still come from the EEG.
            valence = arousal = valence_sd = arousal_sd = float("nan")

        # Samples strictly inside this image's on-screen window. Epochs are cut
        # only from here, so no epoch can straddle two images.
        lo = np.searchsorted(times, ev["shown_at"], side="left")
        hi = np.searchsorted(times, ev["hidden_at"], side="right")
        if hi - lo < n_epoch:
            report.events_too_short += 1
            continue

        for start in range(lo, hi - n_epoch + 1, n_step):
            end = start + n_epoch
            win_t = times[start:end]
            win_v = values[start:end, :]

            # Reject a window spanning a Bluetooth dropout. The timeline is real
            # (the bridge inserts genuine gaps rather than compressing), so a
            # window can look like n_epoch contiguous samples while actually
            # spanning several seconds of missing signal.
            span_s = (win_t[-1] - win_t[0]).total_seconds()
            if span_s > max_span_s:
                report.epochs_gap += 1
                continue

            pkpk = win_v.max(axis=0) - win_v.min(axis=0)
            if np.any(pkpk < cfg.flat_pkpk_uv):
                report.epochs_flat_channel += 1
                if cfg.drop_epoch_on_bad_channel:
                    continue
            if np.any(pkpk > cfg.artefact_pkpk_uv):
                report.epochs_artefact += 1
                if cfg.drop_epoch_on_bad_channel:
                    continue

            epochs.append(Epoch(
                session_id=session_id,
                image_id=str(ev["image_id"]),
                event_id=str(ev["event_id"]),
                t_start=win_t[0],
                t_end=win_t[-1],
                signals={ch: win_v[:, ci].copy() for ci, ch in enumerate(CHANNELS)},
                valence=valence,
                arousal=arousal,
                valence_sd=valence_sd,
                arousal_sd=arousal_sd,
                oasis_theme=ev.get("oasis_theme"),
            ))

    report.epochs_kept = len(epochs)
    return epochs, report
