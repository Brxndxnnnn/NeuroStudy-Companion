# Results Screen — Implementation Plan

Audience: web frontend (Zhao Yu, owner of this screen), backend (Eugene), ML.
Purpose: build the post-session results screen that renders per-stimulus EEG
data — filtered EEG waveforms, mental-state indicators, HR/SpO₂, and
ML-computed frequency bands — with a reactive (zoom/pan/window-select) charting
experience matching the NeeuroSDK control-panel style.

Visual reference: the three NeeuroSDK panels —
- **EEG Waves**: 4 stacked channel traces + HR/SpO₂ text.
- **ABDT Waves**: 5 stacked frequency-band traces (Delta→Gamma), 4 channels overlaid each.
- **Mental States**: 3 stacked traces (Attention, Relaxation, Mental Workload).

The look we want is **stacked "strip chart" small-multiples sharing one time axis**.

---

## 1. Charting library: Apache ECharts (`echarts-for-react`)

Recharts (current `result/page.js`) is SVG-based and will choke on raw EEG
(250 Hz × 4 channels × minutes = 100k+ points). Use **ECharts** instead:

- **Canvas + built-in downsampling** (`sampling: 'lttb'`) renders 100k+ points smoothly.
- **`dataZoom`** — drag-to-zoom, scroll-zoom, pan slider, brush a window (t=0→10).
- **Synced zoom across panels** (`echarts.connect`) — zoom EEG and bands +
  mental-states follow to the same window.
- **Rich custom tooltips** — where instantaneous values (and the stats rail) live.
- Apache-2.0 (free), industry standard for dense time-series dashboards.

(Highcharts needs a commercial license; uPlot is faster but much lower-level.)

---

## 2. Screen layout (mapped to the reference images)

Four vertically stacked, zoom-synced panels + a stats rail on the right:

| Panel            | Looks like    | Content                                                    |
|------------------|---------------|-----------------------------------------------------------|
| Filtered EEG     | EEG Waves     | 4 stacked strips: Fp1, Fp2, T3, T4 (µV)                    |
| Mental States    | Mental States | 3 stacked strips: Attention, Relaxation, Mental Workload   |
| Frequency Bands  | ABDT Waves    | 5 stacked strips: Delta/Theta/Alpha/Beta/Gamma, 4 ch each |
| Vitals           | text header   | HR & SpO₂ — current + avg/min/max cards (not a strip)      |
| Stats rail       | —             | avg / peak / SD for the current zoom window (see §4)       |

All time-series panels share one x-axis and one synced `dataZoom`, so selecting
t=0→10 filters every chart at once. Event markers (image/question boundaries
from `events`) are drawn as shaded bands so "image 3 was here" is visible.

---

## 3. The five data pieces → source → endpoint

| # | Data                                   | Source                        | Computed by | Endpoint                                              |
|---|----------------------------------------|-------------------------------|-------------|-------------------------------------------------------|
| 1 | Filtered EEG waveform (4 ch)           | `eeg_filtered_samples`        | bridge      | `GET /sessions/:id/results/filtered` (exists, windowed) |
| 2 | HR / SpO₂                              | `band_powers.heart_rate/spo2` | bridge      | new `GET /sessions/:id/results/mental`                |
| 3 | Attention / Relaxation / Mental Workload | `band_powers`               | bridge      | same `…/results/mental`                               |
| 4 | Frequency bands (α/β/δ/θ/γ per ch)     | new `ml_band_powers`          | ML          | new `GET /sessions/:id/results/bands`                 |
| 5 | avg / peak / SD                        | derived                       | frontend    | none — computed live (§4)                             |

---

## 4. avg / peak / SD

Two flavors; we want the second:

- **On hover** → ECharts tooltip shows the *instantaneous* value at the cursor
  timestamp. Built-in, free.
- **avg / peak / SD** → aggregates over a *window*. Best UX: a **stats rail that
  recomputes for the currently visible (zoomed) range**. ECharts fires a
  `datazoom` event with the new start/end; slice the loaded array to that range
  and compute mean/max/SD in a few lines of JS, render beside each strip. Zoom
  to t=0→10 and the stats update to that window.

**Consequence: avg/peak/SD need no backend or ML table.** The frontend already
holds the charted points, so it derives the stats itself, reactive to zoom.
(Cross-session precomputed stats for trends would be a later ML job — not v1.)

---

## 5. Data-volume strategy (backend note)

Raw filtered EEG is huge; don't load a whole session at 250 Hz. Two-tier fetch:

- **Overview**: request filtered endpoint with a `max_points` cap so the backend
  **downsamples server-side** (min/max decimation to ~2–4k points) for the
  full-session view.
- **Drill-in**: when the user zooms to a narrow window, re-fetch at full resolution.

Mental-states and ML bands are low-rate (~1–2 Hz) → whole session loads at once,
no tiering needed.

---

## 6. Pointers for the BACKEND (Eugene)

1. **Widen `GET /sessions/:id/results`** → one row **per event**, both stimulus
   types, with metadata (fixes the math-questions-collapse and thin-response
   gaps). Contract:
   ```jsonc
   [{
     "event_id","stimulus_type":"image|question","sequence_no":3,
     "shown_at","hidden_at","duration_s",
     "image_id","filename","category","url",          // image only
     "question_id","prompt","difficulty",             // question only
     "avg_attention","avg_relaxation","avg_mental_workload",
     "avg_heart_rate","avg_spo2","sample_count"
   }]
   ```
   Group by `event_id` (not `image_id`), join `images`/`questions` for labels,
   order by `shown_at`.

2. **New `GET /sessions/:id/results/mental?from&to`** → `band_powers` time series:
   `time, attention, relaxation, mental_workload, heart_rate, spo2`. Whole session
   is fine (~1/s). Powers panels 2 & 3 + Vitals.

3. **Extend `GET /sessions/:id/results/filtered`** → add optional `max_points`
   for server-side downsampling (overview vs drill-in, §5).

4. **New `GET /sessions/:id/results/bands?from&to`** → reads new `ml_band_powers`,
   returns per-channel per-band time series. Powers panel 4.

5. **Trigger ML on end + expose readiness** → in `endSession`, after backfill,
   fire `POST http://ml:8000/infer {session_id}` (fire-and-forget). Add an
   ML-status field (on `GET /sessions/:id` or the bands endpoint) so the frontend
   can poll and show "computing bands…" until ready.

---

## 7. Pointers for the ML

**What to calculate:** a **continuous frequency-band power time-series** from
`eeg_filtered_samples` (the ABDT-Waves chart). On session end, `/infer` should:

1. Load filtered samples for the session (per channel: fp1, fp2, t3, t4).
2. Slide a window across the session — e.g. **2 s window, 0.5 s hop** (tune later).
3. Per window, per channel, compute absolute power in each band:
   **Delta 1–4, Theta 4–8, Alpha 8–12, Beta 12–30, Gamma 30–40 Hz**. Either
   method is fine and yields the same schema:
   - FFT/Welch PSD → integrate over each band (existing `feature_extraction/
     bandpower.py` + `psd.py` already do this), or
   - **elliptic IIR bandpass** per band → RMS power (stated preference).
4. Write one row per window into `ml_band_powers`, timestamp = window centre on
   the DB clock.
5. Optionally tag `current_event_id` (cheap at ~2 Hz) or leave null and let the
   frontend join by time.

ML does **not** compute avg/peak/SD — the frontend derives those (§4).

---

## 8. New DB table (migration 006)

```sql
-- ML-computed spectral band powers (separate from the bridge's SDK band_powers).
-- Sliding-window PSD/elliptic power per channel per band. ~2 rows/sec.
CREATE TABLE ml_band_powers (
    session_id  uuid        NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    time        timestamptz NOT NULL,            -- window CENTRE, DB clock
    window_s    real        NOT NULL DEFAULT 2.0,-- window length used
    hop_s       real        NOT NULL DEFAULT 0.5,-- hop between windows
    method      text,                            -- 'welch_psd' | 'elliptic_rms'
    -- absolute band power (µV²) per channel per band
    fp1_delta real, fp1_theta real, fp1_alpha real, fp1_beta real, fp1_gamma real,
    fp2_delta real, fp2_theta real, fp2_alpha real, fp2_beta real, fp2_gamma real,
    t3_delta  real, t3_theta  real, t3_alpha  real, t3_beta  real, t3_gamma  real,
    t4_delta  real, t4_theta  real, t4_alpha  real, t4_beta  real, t4_gamma  real,
    current_event_id uuid REFERENCES events(event_id) ON DELETE SET NULL,  -- optional
    PRIMARY KEY (session_id, time)
);
SELECT create_hypertable('ml_band_powers', by_range('time'));
SELECT set_chunk_time_interval('ml_band_powers', INTERVAL '1 day');
GRANT SELECT, INSERT ON ml_band_powers TO ml_writer;   -- ML service role (confirm name)
GRANT SELECT            ON ml_band_powers TO app_user;  -- backend reads
```

No RLS on this table (matches `band_powers`/`eeg_raw_samples` — tenant isolation
is at the `sessions` level). Confirm the ML's DB role name (`ml_writer` is a
placeholder).

---

## 9. Frontend build (this screen)

Rebuild `frontend/src/app/session/result/page.js`:

1. Install ECharts, scaffold a reusable synced **strip-chart** component
   (shared x-axis + `dataZoom`).
2. Wire the four panels to the endpoints in §6 (graceful "computing bands…"
   polling for the ML panel).
3. Two-tier filtered-EEG fetch (§5).
4. Live avg/peak/SD stats rail driven by the `datazoom` event (§4).
5. Event-boundary shading from `/results` so stimuli are visible on the timeline.
6. Centralize the hardcoded `http://139.59.126.77` base URL.

Can start against **mocked JSON** matching the §6 contracts so the frontend
isn't blocked on backend/ML.

---

## 10. Design decisions settled during planning

- **No `current_event_id` column on `eeg_filtered_samples`/`eeg_raw_samples`.**
  The two 250 Hz tables attribute to stimuli by **time-window join** against
  `events` (cheap per-window; a stored tag would need an expensive backfill over
  hundreds of thousands of rows). Only the low-rate summary tables
  (`band_powers`, `eeg_readings`) carry the backfilled tag.
- **avg/peak/SD are frontend-derived**, not stored — keeps ML scope to just the
  band time-series.
- **ML bands are a separate table** (`ml_band_powers`), not the bridge's SDK
  `band_powers`, because we compute our own via PSD/elliptic.

---

## Open items

1. Confirm the ML service's DB role name for the `GRANT` in §8.
2. Confirm ML band method (Welch PSD vs elliptic) — schema is identical either way.
3. Decide whether frontend starts against mocks now or waits for the widened
   `/results` endpoint.
