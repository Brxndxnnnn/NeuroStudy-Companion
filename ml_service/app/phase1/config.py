"""
phase1/config.py

Knobs for the EEG -> valence/arousal pipeline, in one place so an experiment is
described by a single object and a result can be traced back to the settings that
produced it.
"""

from dataclasses import dataclass

from app.core.config import settings


@dataclass(frozen=True)
class Phase1Config:
    # ── Epoching ──────────────────────────────────────────────────────────────
    # 2 s window / 0.5 s step, matching the windowing agreed with Zhengda.
    #
    # The two knobs do different jobs and are easy to conflate:
    #   WINDOW controls whether a single epoch is a trustworthy measurement.
    #   STEP   controls how many epochs an image yields.
    # Delta runs down to 0.5 Hz — half a cycle in a 1 s window — so a 1 s epoch
    # cannot measure it. 2 s holds a full cycle. Shrink the STEP, never the
    # window, if more epochs are needed.
    #
    # At the REAL 10 s image duration this gives 17 epochs per image
    # (floor((10 - 2) / 0.5) + 1) -> ~408 per 24-image session. At the 3 s
    # development setting of IMAGE_DISPLAY_MS it gives only 3.
    epoch_s: float = 2.0
    step_s:  float = 0.5

    # Epochs must lie ENTIRELY inside one image's shown_at..hidden_at window.
    # A window straddling a boundary carries EEG from two images but can only be
    # given one label, so it is a mislabelled training row. They are dropped.

    # ── Quality gating ────────────────────────────────────────────────────────
    # Below this peak-to-peak an electrode is railed, not quiet. Validated
    # against every recorded session: dead channels measure 0.005-0.008 µV
    # peak-to-peak, the quietest LIVE channel 37.6 µV. T3/T4 have been dead
    # across the 13 Jul sessions, so this gate is load-bearing, not theoretical.
    flat_pkpk_uv: float = 0.5
    # Above this it is movement/EMG, not EEG.
    artefact_pkpk_uv: float = settings.QUALITY_PKPK_MAX  # 500 µV

    # Drop the whole epoch if any channel is flat or artefacted. The alternative
    # (impute the bad channel) would fabricate the asymmetry features, which are
    # differences BETWEEN channels — a made-up channel makes up the feature.
    drop_epoch_on_bad_channel: bool = True

    # ── Label gating ──────────────────────────────────────────────────────────
    # OASIS ships per-image rater SDs. An image the raters disagreed about has a
    # noisy label, and a noisy label is an unlearnable target. Images above this
    # SD are excluded. OASIS SDs run roughly 0.6-2.0 on the 1-7 scale; 2.0 keeps
    # nearly everything and only trims the genuinely contested images.
    max_label_sd: float = 2.0

    # ── Preprocessing ─────────────────────────────────────────────────────────
    # eeg_filtered_samples is already SDK-filtered, but the SDK's response is not
    # documented. Re-filtering to a KNOWN passband (0.5-45 Hz) + mains notch costs
    # little on already-clean data and means the features have a defined
    # provenance rather than depending on an opaque vendor filter.
    apply_bandpass: bool = True
    apply_notch:    bool = True

    # ── Normalisation ─────────────────────────────────────────────────────────
    # Z-score features WITHIN each session. Absolute EEG amplitude varies hugely
    # between sessions (cap fit, gel, skin impedance, the participant). Without
    # this the model can score well by learning "which session is this?" and
    # regressing session-mean valence — an effect that vanishes on a new
    # participant. Fitted on the training fold only; see evaluate.py.
    per_session_zscore: bool = True

    sample_rate: int = settings.SAMPLE_RATE   # 250 Hz

    @property
    def epoch_samples(self) -> int:
        return int(round(self.epoch_s * self.sample_rate))

    @property
    def step_samples(self) -> int:
        return int(round(self.step_s * self.sample_rate))


DEFAULT = Phase1Config()


# OASIS rates valence and arousal on a 1–7 scale. A linear model can extrapolate
# past those bounds — especially when a session's per-session z-score is fitted on
# only a handful of epochs — so predictions are clamped to this range at inference.
# A value outside 1–7 is meaningless next to the OASIS norms it is charted against.
OASIS_SCALE_MIN: float = 1.0
OASIS_SCALE_MAX: float = 7.0
