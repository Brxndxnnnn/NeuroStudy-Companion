# FFT Band Powers — how the "Frequency bands" chart is computed

**Purpose.** The results-page "Frequency bands" chart no longer plots the SenseBand
SDK's band numbers. We compute band power ourselves, by FFT on the filtered EEG, using
the standard EEG method: **Welch Power Spectral Density → integrate the PSD over each
band → absolute band power in µV²**. This document describes exactly how, so it can be
independently verified.

Everything below lives in `ml_service/app/` and runs in the post-session feature worker
(the same worker that computes the elliptic band stats), triggered when a session
reaches `sync_status = 'completed'`.

---

## The computation, in three steps

### 1. Welch PSD — `feature_extraction/psd.py::compute_psd`

```python
freqs, psd = scipy.signal.welch(
    signal,                       # one channel of filtered EEG, in µV
    fs=250,                       # sample rate (settings.SAMPLE_RATE)
    nperseg=min(256, len(signal)),
    noverlap=nperseg // 2,        # 50% overlap (Welch standard)
    window="hann",
)
```

Welch's method divides the window into overlapping 256-sample segments, applies a Hann
window to each, takes the FFT, and averages the resulting periodograms — a smoother,
lower-variance spectrum than a single FFT. `scipy` returns a **one-sided** PSD with the
default `scaling="density"`, so the units are **µV²/Hz**.

### 2. Integrate over each band — `feature_extraction/bandpower.py`

```python
mask  = (freqs >= low) & (freqs <= high)
power = scipy.integrate.simpson(psd[mask], freqs[mask])   # µV²
```

Absolute band power is the area under the PSD curve within the band's frequency range,
by Simpson's-rule integration. The five standard bands (edges from `settings`):

| band  | range (Hz) |
|-------|------------|
| delta | 0.5 – 4    |
| theta | 4 – 8      |
| alpha | 8 – 13     |
| beta  | 13 – 30    |
| gamma | 30 – 45    |

`all_band_powers()` runs this for all five bands on one channel's spectrum.

### 3. Slide over the session — `feature_extraction/fft_band_power.py`

For each analysis window, for each of the four channels (fp1, fp2, t3, t4), run step 1
then step 2 → five band powers. Defaults:

- **Window: 2.0 s** (`FFT_BANDPOWER_WINDOW_S`) — 500 samples at 250 Hz. A 2 s window holds
  a full cycle of the lowest delta frequency (0.5 Hz); the SDK's 1 s window does not.
- **Step: 0.5 s** (`FFT_BANDPOWER_STEP_S`) — gives a dense timeline (~2 points/second).

Two correctness details in the sliding logic:

- **Gap-aware.** A window whose samples straddle a Bluetooth dropout is **dropped** — its
  wall-clock span (last-sample time − first-sample time) would exceed what its sample
  count implies, so it is not one contiguous stretch of EEG.
- **Honest timestamps.** Each window is stamped at its **centre**, read from the samples'
  own `time` column — never derived from `sample_index / fs`, which would ignore every
  dropout and drift for the rest of the session.

Input is `eeg_filtered_samples` (already filtered, in µV). Output is one WIDE row per
window written to the `fft_band_powers` table (`fp1_delta … t4_gamma`, µV²), read by the
backend endpoint `GET /api/sessions/:id/results/fft_bandpower`.

---

## How to verify it

Two properties certify the result independently of the code:

1. **Parseval / normalisation.** Integrating a correctly-scaled PSD over *all* frequencies
   equals the signal's variance. On broadband white noise this recovers the variance to
   within ~1% — which is what proves the µV² scaling is right.
2. **Known signal.** A sinusoid of amplitude `A` has power `A²/2`, and it should land
   entirely in the band containing its frequency. E.g. a 20 µV, 10 Hz sine → ~200 µV² in
   alpha, ≈ 0 elsewhere.

Both are encoded as automated tests in **`ml_service/app/tests/test_fft_band_power.py`**:

```
cd ml_service && pytest app/tests/test_fft_band_power.py -v
```

The tests cover: pure-tone magnitude and band placement, multi-tone per-band power,
µV² amplitude scaling (double A → 4× power), Parseval on a broadband signal, sliding-
window centres/channels, and gap-dropping.

**Known nuance (not a bug):** a *pure sine tone* sitting exactly on an FFT bin reads
~10% low, because a Hann window leaks a line spectrum across neighbouring bins. This was
checked explicitly — an off-bin tone and broadband white noise both recover Parseval to
≈1.00 — so it is spectral leakage inherent to windowed estimation of line spectra, not a
normalisation error. Real EEG is broadband and has no line spectra, so it behaves like
the white-noise case.

---

## One open knob worth a look

Inside each 2 s window, Welch uses 256-sample segments (~1 Hz resolution). This is a
deliberate trade: shorter segments average more (smoother per-window estimate), but the
2 s window's potential ~0.5 Hz resolution is not fully used — which matters most for the
delta band. Raising `nperseg` toward the full 500-sample window trades some smoothing for
finer low-frequency resolution. Left at the smoother default for now; flagged for review.
