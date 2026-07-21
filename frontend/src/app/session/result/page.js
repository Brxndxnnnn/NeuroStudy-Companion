"use client";
import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  getSession,
  getSessionResultsFiltered,
  getSessionResultsBandPower,
  getSessionResultsFftBandPower,
  getSessionResultEvents,
  getSessionEllipticBandStats,
} from "@/utils/api";
import { buildEventWindows } from "@/utils/events";
import { SessionTopBar } from "@/components/TopNav";
import { Card, CardHeader, Button, Label, Pill, Alert, Spinner, Select } from "@/components/ui";
import EegStripChart from "@/components/EegStripChart";
import TimeSeriesChart from "@/components/TimeSeriesChart";
import BandProfileChart from "@/components/BandProfileChart";
import StimulusModal from "@/components/StimulusModal";

const CHANNELS = [
  { key: "fp1_left_front", prefix: "fp1", label: "Fp1", color: "--ch-fp1" },
  { key: "fp2_right_front", prefix: "fp2", label: "Fp2", color: "--ch-fp2" },
  { key: "t3_left_temporal", prefix: "t3", label: "T3", color: "--ch-t3" },
  { key: "t4_right_temporal", prefix: "t4", label: "T4", color: "--ch-t4" },
];

// Ascending frequency — the hue order is CVD-validated in this sequence.
const BANDS = [
  { key: "delta", label: "Delta", greek: "δ", color: "--band-delta" },
  { key: "theta", label: "Theta", greek: "θ", color: "--band-theta" },
  { key: "alpha", label: "Alpha", greek: "α", color: "--band-alpha" },
  { key: "beta", label: "Beta", greek: "β", color: "--band-beta" },
  { key: "gamma", label: "Gamma", greek: "γ", color: "--band-gamma" },
];

const MENTAL = [
  { key: "attention", label: "Attention", color: "--ms-attention" },
  { key: "relaxation", label: "Relaxation", color: "--ms-relaxation" },
  { key: "mental_workload", label: "Workload", color: "--ms-workload" },
];

// Which statistic the elliptic card plots.
//
// SD is the default and the only honest "amplitude" of the three. ml_service
// bandpasses the signal before taking the statistic, and a bandpassed signal is
// zero-mean by construction, so *_mean collapses towards zero: on the one session
// that has data, |mean|/std is 0.03 for alpha and 0.01 for beta and gamma. SD is
// the RMS amplitude about that zero. Mean is kept because it is in the data and
// hiding a column invites someone to "fix" its absence, but it is labelled for
// what it is.
const ELLIPTIC_STATS = [
  { key: "std", label: "SD", hint: "How strong the signal typically is — the number that matters here" },
  { key: "peak", label: "Peak", hint: "The single biggest spike in this time window" },
  { key: "mean", label: "Mean", hint: "Almost always close to zero here — not a useful reading for this chart" },
];

// Peak carries electrode-pop artefacts orders of magnitude above the signal (this
// session: median peak in the tens of µV, maximum 55,814 µV — 55 millivolts, which
// is not EEG). Autoscaling to that flattens every real trace onto the axis, so the
// axis is capped at a robust upper bound and the excursions are reported instead of
// being allowed to erase the data.
const ROBUST_PCT = 0.99;
const OUTLIER_RATIO = 3;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

// elliptic_band_stats arrives as one row per (window x CHANNEL) — 4 rows per
// window — with the five bands as COLUMNS (delta_mean, delta_std, delta_peak, …).
// Pivot to one row per window, keyed <channel>_<band>_<stat>, which is the shape
// TimeSeriesChart consumes.
//
// ⚠ This is NOT the shape db/migrations/005 describes (that has a `band` text
// column). The deployed table is the source of truth here; the migration in the
// repo is stale.
//
// The endpoint has no ORDER BY and no t_seconds (unlike every sibling results
// endpoint), so both are produced here: the seconds axis is derived from
// sessions.start_time, the same origin the EEG, band-power and event-marker series
// already use — otherwise this card's x-axis would silently disagree with the
// charts above it and with the stimulus markers.
function buildEllipticRows(rows, sessionStart) {
  if (!Array.isArray(rows) || rows.length === 0) return { rows: [], meta: null };

  const t0 = new Date(sessionStart).getTime();
  const byWindow = new Map();

  for (const r of rows) {
    if (!r.channel) continue;
    const ms = new Date(r.time_start).getTime();
    let w = byWindow.get(ms);
    if (!w) {
      w = {
        t_seconds: (ms - t0) / 1000,
        t_end: (new Date(r.time_end).getTime() - t0) / 1000,
        window_number: r.window_number,
      };
      byWindow.set(ms, w);
    }
    for (const b of BANDS) {
      for (const s of ELLIPTIC_STATS) {
        w[`${r.channel}_${b.key}_${s.key}`] = r[`${b.key}_${s.key}`];
      }
    }
  }

  const out = [...byWindow.values()].sort((a, b) => a.t_seconds - b.t_seconds);
  const meta = {
    window_size_s: rows[0].window_size_s,
    step_s: rows[0].step_s,
    windows: out.length,
  };
  return { rows: out, meta };
}

// First index with t_seconds >= target (binary search; rows are ascending).
function lowerBound(rows, target) {
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t_seconds < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// A live electrode swings by tens of µV; a railed one (SDK reports "connected" while the
// ADC sits on a constant) lands here as a sub-0.1 µV DC residue left by the SDK's filter.
// Below this peak-to-peak, the channel recorded nothing and must be called dead rather
// than autoscaled into a convincing-looking trace.
const FLAT_PKPK_UV = 0.5;

function channelStats(samples, key, from, to) {
  const start = lowerBound(samples, from);
  const end = lowerBound(samples, to);
  let sum = 0, peak = 0, count = 0, min = Infinity, max = -Infinity;
  for (let i = start; i < end; i++) {
    const v = samples[i][key];
    if (v == null || Number.isNaN(v)) continue;
    sum += v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
    if (v < min) min = v;
    if (v > max) max = v;
    count++;
  }
  if (!count) return { mean: null, peak: null, sd: null, pkpk: null, flat: false, count: 0 };
  const mean = sum / count;
  let sq = 0;
  for (let i = start; i < end; i++) {
    const v = samples[i][key];
    if (v == null || Number.isNaN(v)) continue;
    sq += (v - mean) * (v - mean);
  }
  const pkpk = max - min;
  return { mean, peak, sd: Math.sqrt(sq / count), pkpk, flat: pkpk < FLAT_PKPK_UV, count };
}

// mean / min / max for a 1 Hz series, skipping nulls (the bridge leaves HR and
// SpO2 null until the pulse sensor has a lock).
function seriesStats(rows, key, from, to) {
  const start = lowerBound(rows, from);
  const end = lowerBound(rows, to);
  let sum = 0, count = 0, min = Infinity, max = -Infinity;
  for (let i = start; i < end; i++) {
    const v = rows[i][key];
    if (v == null || Number.isNaN(v)) continue;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
    count++;
  }
  if (!count) return { mean: null, min: null, max: null, count: 0 };
  return { mean: sum / count, min, max, count };
}

const hasAny = (rows, key) => rows.some((r) => r[key] != null && !Number.isNaN(r[key]));

function fmt(v, digits = 1) {
  return v == null ? "—" : v.toFixed(digits);
}

// EEG µV values span orders of magnitude (a railed channel sits near 0.02), so a fixed
// 1 decimal place would render every reading on a dead channel as a plausible-looking "0.0".
function fmtUv(v) {
  if (v == null || Number.isNaN(v)) return "—";
  const a = Math.abs(v);
  return v.toFixed(a >= 10 ? 1 : a >= 1 ? 2 : 3);
}

// Stable identity: both chart components re-init their canvas when the `events`
// array identity changes, so hiding markers must pass the SAME empty array every
// render rather than a fresh [] literal.
const NO_EVENTS = [];

// Per-chart marker switch. Markers are genuinely useful and genuinely in the way —
// a dense 24-image session tiles the whole axis with translucent bands, which is
// exactly what you want when locating a stimulus response and exactly what you
// don't when reading the trace underneath. Each chart carries its own switch, so
// turning them off where they obscure something doesn't lose them where they help.
function MarkerToggle({ on, onToggle }) {
  return (
    <button
      onClick={onToggle}
      aria-pressed={on}
      title={on ? "Hide stimulus markers" : "Show stimulus markers"}
      // py-2, not py-1.5: matches the toolbar Select's sm size and a segmented
      // button group's effective height (its own py-1.5 plus its wrapper's
      // p-0.5), so this sits flush with whichever of those it's next to in a
      // card's actions row instead of reading a couple px shorter.
      className={`px-3 py-2 rounded-lg text-[12px] font-semibold transition-colors border ${
        on
          ? "bg-inset text-ink border-border"
          : "bg-transparent text-muted border-border hover:text-ink"
      }`}
    >
      {on ? "Markers on" : "Markers off"}
    </button>
  );
}

// Labeled wrapper for one header control (a select or a button group). The
// label sits above the control so a header with several of these reads as
// "View: ___  Channel: ___  Markers: ___" instead of an unlabeled row of
// controls the technician has to hover each one to identify.
function ControlGroup({ label, children }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="px-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-muted">
        {label}
      </span>
      {children}
    </div>
  );
}


function fmtDuration(sec) {
  if (!sec || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function SessionResults() {
  const router = useRouter();
  const [samples, setSamples] = useState([]);
  const [bandRows, setBandRows] = useState([]);   // SDK band_powers — now only mental state + vitals
  const [fftBandRows, setFftBandRows] = useState([]); // our FFT band powers — the Frequency bands chart
  const [bandError, setBandError] = useState("");
  const [ellipticRows, setEllipticRows] = useState([]);
  const [ellipticMeta, setEllipticMeta] = useState(null);
  const [ellipticError, setEllipticError] = useState("");
  // The feature job's own status, straight from sessions.features_status. An empty
  // elliptic response cannot tell "still computing" from "finished with nothing" from
  // "the worker crashed" — only the worker knows, and this is how it says so.
  //   null / "running" → computing (poll)
  //   "ready"          → rows exist
  //   "failed"         → features_error explains why
  const [featuresStatus, setFeaturesStatus] = useState(null);
  const [featuresError, setFeaturesError] = useState("");
  const [sessionId, setSessionId] = useState(null);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [ellipticChannel, setEllipticChannel] = useState("fp1");
  const [ellipticStat, setEllipticStat] = useState("std");
  const [ellipticRange, setEllipticRange] = useState({ from: 0, to: 0 });
  // Window inspector: index into ellipticRows (not window_number — that is the
  // worker's own 1-based counter and need not be contiguous if it ever skips a
  // window, so it is displayed but never used to index).
  const [ellipticIdx, setEllipticIdx] = useState(0);
  const [ellipticView, setEllipticView] = useState("window"); // "window" | "timeline"
  const [events, setEvents] = useState([]);
  const [selectedEvent, setSelectedEvent] = useState(null);
  // One per chart, so a chart can drop its markers without the others losing theirs.
  const [markers, setMarkers] = useState({
    eeg: true,
    bands: true,
    elliptic: true,
    mental: true,
    vitals: true,
  });
  const toggleMarkers = useCallback(
    (key) => setMarkers((m) => ({ ...m, [key]: !m[key] })),
    []
  );
  // Passing NO_EVENTS (a stable reference) rather than [] keeps the chart from
  // re-initialising its canvas on every unrelated render.
  const chartEvents = useCallback(
    (key) => (markers[key] ? events : NO_EVENTS),
    [markers, events]
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [patientName, setPatientName] = useState("");
  const [duration, setDuration] = useState(0);

  const [range, setRange] = useState({ from: 0, to: 0 });
  const [bandRange, setBandRange] = useState({ from: 0, to: 0 });
  const [mentalRange, setMentalRange] = useState({ from: 0, to: 0 });
  const [vitalsRange, setVitalsRange] = useState({ from: 0, to: 0 });
  const [channel, setChannel] = useState(CHANNELS[0].prefix);
  // "stacked" = one strip per channel, "overlay" = all four on a shared µV axis,
  // or a single channel prefix to isolate one trace.
  const [eegView, setEegView] = useState("stacked");

  useEffect(() => {
    const load = async () => {
      // ?session_id=… lets any past session be opened from the sessions list;
      // without it we fall back to the session just recorded in this browser.
      const fromQuery = new URLSearchParams(window.location.search).get("session_id");
      const sessionId = fromQuery || localStorage.getItem("currentSessionId");
      if (!fromQuery) setPatientName(localStorage.getItem("currentClientName") || "");

      if (!sessionId) {
        setError("No session selected. Pick one from the sessions list.");
        setIsLoading(false);
        return;
      }

      try {
        // 1. Session metadata → patient + duration (the window we request).
        const sRes = await getSession(sessionId);
        if (!sRes.ok) throw new Error("session");
        const sData = await sRes.json();
        const session = sData.session || sData;
        if (session.client_name) setPatientName(session.client_name);
        setSessionId(sessionId);
        setFeaturesStatus(session.features_status ?? null);
        setFeaturesError(session.features_error || "");

        let durSec = 0;
        if (session.start_time && session.end_time) {
          durSec = (new Date(session.end_time) - new Date(session.start_time)) / 1000;
        }
        if (!durSec || durSec <= 0) {
          setError("This session has no completed recording window yet.");
          setIsLoading(false);
          return;
        }
        setDuration(durSec);

        // 2. Filtered EEG (full-resolution; the chart decimates), the 1 Hz
        //    band-power stream, and the per-event summary, in parallel. Band or
        //    event failures degrade their own features — the EEG still renders.
        const [fRes, bRes, eRes, elRes, fftRes] = await Promise.all([
          getSessionResultsFiltered(sessionId, 0, Math.ceil(durSec) + 1),
          getSessionResultsBandPower(sessionId).catch(() => null),
          getSessionResultEvents(sessionId).catch(() => null),
          getSessionEllipticBandStats(sessionId).catch(() => null),
          getSessionResultsFftBandPower(sessionId).catch(() => null),
        ]);

        if (!fRes.ok) throw new Error("filtered");
        const fData = await fRes.json();
        const rows = fData.samples || [];
        if (rows.length === 0) {
          setError("No EEG samples were recorded for this session.");
          setIsLoading(false);
          return;
        }
        setSamples(rows);
        setRange({ from: rows[0].t_seconds, to: rows[rows.length - 1].t_seconds });

        // Stimulus markers: prefer the rich per-event rows (image URL, question
        // prompt, per-event averages); fall back to the bare timing array that
        // rides along with the filtered payload.
        let eventRows = null;
        if (eRes && eRes.ok) {
          const eData = await eRes.json();
          if (Array.isArray(eData) && eData.length) eventRows = eData;
        }
        if (!eventRows && Array.isArray(fData.events_timing) && fData.events_timing.length) {
          eventRows = fData.events_timing;
        }
        if (eventRows) setEvents(buildEventWindows(eventRows, session.start_time, durSec));

        // SDK band_powers now feeds ONLY mental state + vitals — its band columns are
        // superseded by our own FFT band powers (fftRes below). If it fails, those two
        // secondary cards simply don't render; the frequency-band chart is unaffected.
        if (bRes && bRes.ok) {
          const bData = await bRes.json();
          const bRows = bData.samples || [];
          if (bRows.length) {
            const span = { from: bRows[0].t_seconds, to: bRows[bRows.length - 1].t_seconds };
            setBandRows(bRows);
            setMentalRange(span);
            setVitalsRange(span);
          }
        }

        // Frequency bands: our OWN FFT-computed powers, not the SDK's. Computed by
        // ml_service after the session completes, so like the elliptic stats they may
        // legitimately not be there yet on a freshly-finished session.
        if (!fftRes || !fftRes.ok) {
          setBandError("Failed to load frequency-band powers.");
        } else {
          const fftData = await fftRes.json();
          const fftRows = fftData.samples || [];
          if (fftRows.length === 0) {
            setBandError("Frequency-band powers have not been computed for this session yet.");
          } else {
            setFftBandRows(fftRows);
            setBandRange({ from: fftRows[0].t_seconds, to: fftRows[fftRows.length - 1].t_seconds });
          }
        }

        // Elliptic band stats are computed by ml_service AFTER the bridge marks the
        // session completed, so on a freshly-finished session they legitimately are
        // not there yet. sessions.features_status (above) says which case this is;
        // the rows are only expected once it reads 'ready'.
        if (!elRes || !elRes.ok) {
          setEllipticError("Failed to load elliptic band statistics.");
        } else {
          const elData = await elRes.json();
          const { rows: elRows, meta } = buildEllipticRows(
            Array.isArray(elData) ? elData : [],
            session.start_time
          );
          if (elRows.length > 0) {
            setEllipticRows(elRows);
            setEllipticMeta(meta);
            setEllipticRange({
              from: elRows[0].t_seconds,
              to: elRows[elRows.length - 1].t_seconds,
            });
          }
        }
      } catch (err) {
        setError(
          err.message === "filtered"
            ? "Failed to load EEG waveforms from the database."
            : "Failed to load the session. Please try again."
        );
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, []);

  // The feature job runs after the recording ends, so a technician who goes straight
  // from the last math question to the results screen will usually arrive BEFORE the
  // rows exist. Poll until the worker says 'ready', then pull the rows in — the chart
  // appears on its own rather than requiring a reload nobody would think to do.
  //
  // Bounded, because a worker that dies leaves the status on 'running' until its stale
  // claim is reclaimed. An unbounded poll would spin forever showing "computing" for a
  // job that is never coming back.
  const ellipticComputing =
    ellipticRows.length === 0 &&
    !ellipticError &&
    featuresStatus !== "failed" &&
    !pollTimedOut;

  useEffect(() => {
    if (!sessionId || !ellipticComputing || isLoading) return;

    let cancelled = false;
    const startedAt = Date.now();
    const TIMEOUT_MS = 3 * 60 * 1000;

    const poll = async () => {
      if (cancelled) return;

      if (Date.now() - startedAt > TIMEOUT_MS) {
        setPollTimedOut(true);
        return;
      }

      try {
        const sRes = await getSession(sessionId);
        if (!sRes.ok || cancelled) return;
        const sData = await sRes.json();
        const session = sData.session || sData;

        setFeaturesStatus(session.features_status ?? null);
        setFeaturesError(session.features_error || "");

        if (session.features_status === "failed") return;   // stop; the card explains
        if (session.features_status !== "ready") return;    // still going; tick again

        const elRes = await getSessionEllipticBandStats(sessionId).catch(() => null);
        if (!elRes || !elRes.ok || cancelled) return;

        const { rows, meta } = buildEllipticRows(await elRes.json(), session.start_time);
        if (!rows.length || cancelled) return;

        setEllipticRows(rows);
        setEllipticMeta(meta);
        setEllipticRange({
          from: rows[0].t_seconds,
          to: rows[rows.length - 1].t_seconds,
        });
      } catch {
        // A transient failure is not a verdict — the next tick tries again.
      }
    };

    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId, ellipticComputing, isLoading]);

  const onEegRange = useCallback((from, to) => setRange({ from, to }), []);
  const onBandRange = useCallback((from, to) => setBandRange({ from, to }), []);
  const onMentalRange = useCallback((from, to) => setMentalRange({ from, to }), []);
  const onVitalsRange = useCallback((from, to) => setVitalsRange({ from, to }), []);
  const onEllipticRange = useCallback((from, to) => setEllipticRange({ from, to }), []);

  // Which traces the EEG chart draws. Memoised because EegStripChart re-inits the
  // canvas whenever this array identity changes.
  const eegChannels = useMemo(() => {
    if (eegView === "stacked" || eegView === "overlay") return CHANNELS;
    return CHANNELS.filter((ch) => ch.prefix === eegView);
  }, [eegView]);

  // avg / peak / SD per channel over the visible EEG window. Always all four —
  // identical numbers across channels here would mean duplicated data.
  const stats = useMemo(() => {
    if (!samples.length) return [];
    return CHANNELS.map((ch) => ({ ...ch, ...channelStats(samples, ch.key, range.from, range.to) }));
  }, [range, samples]);

  // ── Frequency bands ───────────────────────────────────────────────────────
  // `channel` holds either a channel prefix or "stacked".
  const bandMulti = channel === "stacked";

  const bandPanels = useMemo(() => {
    if (channel === "stacked") {
      // A grid per channel, each carrying the same five bands. The band names
      // repeat across panels on purpose: ECharts keys the legend by series name,
      // so toggling "Alpha" hides alpha in all four at once.
      return CHANNELS.map((ch) => ({
        label: ch.label,
        unit: "",
        series: BANDS.map((b) => ({
          key: `${ch.prefix}_${b.key}`,
          label: b.label,
          color: b.color,
        })),
      }));
    }
    return [
      {
        label: "Power",
        unit: "",
        series: BANDS.map((b) => ({ key: `${channel}_${b.key}`, label: b.label, color: b.color })),
      },
    ];
  }, [channel]);

  const bandStats = useMemo(() => {
    if (!fftBandRows.length || bandMulti) return [];
    return BANDS.map((b) => ({
      ...b,
      ...seriesStats(fftBandRows, `${channel}_${b.key}`, bandRange.from, bandRange.to),
    }));
  }, [fftBandRows, channel, bandRange, bandMulti]);

  // In a multi-channel view the per-band rail would have to be repeated four
  // times; a channel x band grid says the same thing once, and answers the
  // question the multi-channel views are asked for — which channel carries this.
  const bandGrid = useMemo(() => {
    if (!fftBandRows.length || !bandMulti) return [];
    return CHANNELS.map((ch) => ({
      ...ch,
      values: BANDS.map(
        (b) => seriesStats(fftBandRows, `${ch.prefix}_${b.key}`, bandRange.from, bandRange.to).mean
      ),
    }));
  }, [fftBandRows, bandRange, bandMulti]);

  // ── Elliptic band statistics (ml_service) ─────────────────────────────────
  // `ellipticChannel` is either a channel prefix or "all".
  const ellipticAll = ellipticChannel === "all";
  const currentEllipticStat = ELLIPTIC_STATS.find((s) => s.key === ellipticStat);
  // Statistic only matters where more than one could plausibly be on screen —
  // see the header control's own comment for why. Used both to show/hide that
  // control and to name the current one in the subtitle below it.
  const ellipticStatMatters = ellipticView === "timeline" || ellipticAll;
  const ellipticShownChannels = useMemo(
    () => (ellipticAll ? CHANNELS : CHANNELS.filter((c) => c.prefix === ellipticChannel)),
    [ellipticAll, ellipticChannel]
  );

  // Same shape as the band-power card above, but a different QUANTITY: these are
  // µV amplitude statistics from an elliptic bandpass, not µV² FFT power. The two
  // are never combined on one axis, which is why this is its own card rather than
  // another panel on the one above.
  // Robust y-axis. An electrode pop puts a single 55 mV value in `peak`, and left
  // to autoscale it compresses every genuine trace onto the zero line — the chart
  // would technically be correct and completely unreadable. Cap the axis at the
  // 99th percentile and count what lands above it, so the outliers are declared
  // rather than allowed to erase the signal.
  const ellipticAxis = useMemo(() => {
    if (!ellipticRows.length) return { max: undefined, clipped: 0, maxValue: null };
    const vals = [];
    for (const row of ellipticRows) {
      for (const ch of ellipticShownChannels) {
        for (const b of BANDS) {
          const v = row[`${ch.prefix}_${b.key}_${ellipticStat}`];
          if (typeof v === "number" && Number.isFinite(v)) vals.push(v);
        }
      }
    }
    if (!vals.length) return { max: undefined, clipped: 0, maxValue: null };
    const sorted = [...vals].sort((a, b) => a - b);
    const p99 = percentile(sorted, ROBUST_PCT);
    const maxValue = sorted[sorted.length - 1];
    // Only clamp when there is a genuine outlier tail; a well-behaved series keeps
    // its natural autoscale.
    if (p99 == null || maxValue <= p99 * OUTLIER_RATIO) {
      return { max: undefined, clipped: 0, maxValue };
    }
    const cap = p99;
    return { max: cap, clipped: vals.filter((v) => v > cap).length, maxValue };
  }, [ellipticRows, ellipticShownChannels, ellipticStat]);

  const ellipticPanels = useMemo(() => {
    const statLabel = ELLIPTIC_STATS.find((s) => s.key === ellipticStat)?.label ?? "SD";
    // "All" gets a grid per channel rather than 20 lines on one axis: these are
    // absolute amplitudes, and a dead or noisy electrode sits on a completely
    // different scale from a healthy one, so a shared axis would flatten the rest.
    if (ellipticAll) {
      return CHANNELS.map((ch) => ({
        label: ch.label,
        unit: "µV",
        max: ellipticAxis.max,
        series: BANDS.map((b) => ({
          key: `${ch.prefix}_${b.key}_${ellipticStat}`,
          label: b.label,
          color: b.color,
        })),
      }));
    }
    return [
      {
        label: statLabel,
        unit: "µV",
        max: ellipticAxis.max,
        series: BANDS.map((b) => ({
          key: `${ellipticChannel}_${b.key}_${ellipticStat}`,
          label: b.label,
          color: b.color,
        })),
      },
    ];
  }, [ellipticChannel, ellipticAll, ellipticStat, ellipticAxis.max]);

  // Per-band rail for the selected channel. Meaningless under "All", which has no
  // single channel to report — the profile chart below covers that case instead.
  const ellipticStats = useMemo(() => {
    if (!ellipticRows.length || ellipticAll) return [];
    return BANDS.map((b) => ({
      ...b,
      ...seriesStats(
        ellipticRows,
        `${ellipticChannel}_${b.key}_${ellipticStat}`,
        ellipticRange.from,
        ellipticRange.to
      ),
    }));
  }, [ellipticRows, ellipticAll, ellipticChannel, ellipticStat, ellipticRange]);

  // Same rule as the window view: never draw channels the card is not showing.
  const ellipticProfile = useMemo(() => {
    if (!ellipticRows.length) return [];
    const avg = (key) =>
      seriesStats(ellipticRows, key, ellipticRange.from, ellipticRange.to).mean;
    if (ellipticAll) {
      return CHANNELS.map((ch) => ({
        label: ch.label,
        values: Object.fromEntries(
          BANDS.map((b) => [b.key, avg(`${ch.prefix}_${b.key}_${ellipticStat}`)])
        ),
      }));
    }
    return ELLIPTIC_STATS.map((s) => ({
      label: s.label,
      values: Object.fromEntries(
        BANDS.map((b) => [b.key, avg(`${ellipticChannel}_${b.key}_${s.key}`)])
      ),
    }));
  }, [ellipticRows, ellipticAll, ellipticChannel, ellipticStat, ellipticRange]);

  // ── Single-window inspector ───────────────────────────────────────────────
  // One window is a single instant on the timeline but a full 4-channel x 5-band
  // x 3-stat snapshot underneath — 60 numbers the timeline can only show one
  // slice of at a time. Stepping through windows is the way to read what the
  // spectrum actually did while one image was on screen.
  const ellipticWindow = ellipticRows[ellipticIdx] ?? null;

  // Values for THIS window only — not averaged over the visible range, which is
  // what the profile chart below the timeline shows.
  //
  // The profile chart follows the channel selection — showing all four channels
  // while only Fp1 is selected would claim the card is about data it isn't.
  //
  //   "All"           -> a column group per channel, drawn as SD. The three
  //                      statistics do not share an axis (peak runs an order of
  //                      magnitude above SD, mean sits at zero), so a cross-channel
  //                      comparison has to pick one, and SD is the amplitude.
  //   single channel  -> a column group per STATISTIC, so SD, peak and mean are all
  //                      visible at once for that channel. They still do not share a
  //                      scale, but grouped side by side that is legible rather than
  //                      misleading: each group is read against itself.
  const ellipticWindowProfile = useMemo(() => {
    if (!ellipticWindow) return [];
    if (ellipticAll) {
      return CHANNELS.map((ch) => ({
        label: ch.label,
        values: Object.fromEntries(
          BANDS.map((b) => [b.key, ellipticWindow[`${ch.prefix}_${b.key}_${ellipticStat}`] ?? null])
        ),
      }));
    }
    return ELLIPTIC_STATS.map((s) => ({
      label: s.label,
      values: Object.fromEntries(
        BANDS.map((b) => [b.key, ellipticWindow[`${ellipticChannel}_${b.key}_${s.key}`] ?? null])
      ),
    }));
  }, [ellipticWindow, ellipticAll, ellipticStat, ellipticChannel]);

  // Which stimulus was on screen during this window. A window straddling two
  // stimuli belongs cleanly to neither, so match on its midpoint and say when it
  // sits in a gap rather than silently attributing it to the nearest one.
  const ellipticWindowEvent = useMemo(() => {
    if (!ellipticWindow || !events.length) return null;
    const mid = (ellipticWindow.t_seconds + ellipticWindow.t_end) / 2;
    return events.find((e) => mid >= e.from && mid < e.to) ?? null;
  }, [ellipticWindow, events]);

  // A railed electrode still produces rows here — an elliptic filter over a
  // constant returns a near-zero amplitude, which plots as a perfectly flat trace
  // rather than as an absence. Name the channels that recorded nothing, so this
  // card cannot imply the temporal lobes were measured when they were not.
  const ellipticDead = useMemo(() => {
    if (!ellipticRows.length) return [];
    return CHANNELS.filter((ch) => {
      const peak = Math.max(
        ...BANDS.map(
          (b) =>
            seriesStats(
              ellipticRows,
              `${ch.prefix}_${b.key}_peak`,
              ellipticRange.from,
              ellipticRange.to
            ).mean ?? 0
        )
      );
      return peak < FLAT_PKPK_UV;
    }).map((ch) => ch.label);
  }, [ellipticRows, ellipticRange]);

  // ── Mental state ──────────────────────────────────────────────────────────
  // The bridge writes these as a 0–1 fraction, so the axis is pinned to 0–1
  // rather than auto-scaling (which would make small wobbles look dramatic).
  const mentalPanels = useMemo(
    () => [{ label: "Index", unit: "", min: 0, max: 1, decimals: 2, series: MENTAL }],
    []
  );

  const mentalStats = useMemo(() => {
    if (!bandRows.length) return [];
    return MENTAL.map((m) => ({
      ...m,
      ...seriesStats(bandRows, m.key, mentalRange.from, mentalRange.to),
    }));
  }, [bandRows, mentalRange]);

  const qualityStat = useMemo(
    () => (bandRows.length ? seriesStats(bandRows, "signal_quality", mentalRange.from, mentalRange.to) : null),
    [bandRows, mentalRange]
  );

  // ── Vitals ────────────────────────────────────────────────────────────────
  // HR (bpm) and SpO2 (%) never share a y-axis — each gets its own panel.
  const hasHr = useMemo(() => hasAny(bandRows, "heart_rate"), [bandRows]);
  const hasSpo2 = useMemo(() => hasAny(bandRows, "spo2"), [bandRows]);

  const vitalPanels = useMemo(() => {
    const panels = [];
    if (hasHr) {
      panels.push({
        label: "Heart rate",
        unit: "bpm",
        series: [{ key: "heart_rate", label: "Heart rate", color: "--vital-hr" }],
      });
    }
    if (hasSpo2) {
      panels.push({
        label: "SpO₂",
        unit: "%",
        series: [{ key: "spo2", label: "SpO₂", color: "--vital-spo2" }],
      });
    }
    return panels;
  }, [hasHr, hasSpo2]);

  const hrStats = useMemo(
    () => (hasHr ? seriesStats(bandRows, "heart_rate", vitalsRange.from, vitalsRange.to) : null),
    [bandRows, hasHr, vitalsRange]
  );
  const spo2Stats = useMemo(
    () => (hasSpo2 ? seriesStats(bandRows, "spo2", vitalsRange.from, vitalsRange.to) : null),
    [bandRows, hasSpo2, vitalsRange]
  );

  const windowLen = Math.max(0, range.to - range.from);
  // The frequency-bands card is driven by our FFT powers; the surrounding results
  // section shows whenever ANY of its cards has data (FFT bands, elliptic stats, or the
  // SDK-derived mental-state / vitals), so repointing the bands to FFT never hides the
  // others — e.g. an older session backfilled before FFT bands existed.
  const hasFft = fftBandRows.length > 0;
  const hasBands = hasFft || bandRows.length > 0 || ellipticRows.length > 0;

  return (
    <main className="min-h-screen bg-ground flex flex-col">
      <SessionTopBar
        onBack={() => router.push("/sessions")}
        backLabel="Sessions"
        patient={patientName}
        right={<Button variant="ghost" size="sm" onClick={() => router.push("/history")}>Done</Button>}
      />

      <div className="max-w-6xl mx-auto w-full px-5 sm:px-8 py-8 space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[26px] font-bold tracking-tight text-ink">Session results</h1>
            <p className="mt-1 text-[14px] text-muted">
              {patientName ? `${patientName} · ` : ""}Filtered EEG · {fmtDuration(duration)}
            </p>
          </div>
          {samples.length > 0 && (
            <Pill tone="neutral">
              {samples.length.toLocaleString()} samples · viewing {fmtDuration(windowLen)}
            </Pill>
          )}
        </div>

        {isLoading ? (
          <Card className="p-16 flex flex-col items-center justify-center gap-3 text-muted">
            <Spinner size={28} className="text-accent" />
            <span className="font-medium">Loading EEG waveforms…</span>
          </Card>
        ) : error ? (
          <Card className="p-10 flex items-center justify-center">
            <Alert tone="crit">{error}</Alert>
          </Card>
        ) : (
          <>
            {/* ── Filtered EEG ─────────────────────────────────────────────── */}
            <Card className="overflow-hidden">
              <CardHeader
                title="Filtered EEG"
                subtitle={
                  events.length
                    ? "The raw signal in µV. Drag to zoom, scroll to pan — the numbers below update to match what's on screen. Shaded bands mark when an image (teal) or question (amber) was shown; click one to see it."
                    : "The raw signal in µV. Drag to zoom, scroll to pan — the numbers below update to match what's on screen."
                }
                actions={
                  <div className="flex flex-wrap items-end gap-3">
                    <ControlGroup label="View">
                      <div className="w-28">
                        <Select
                          aria-label="EEG view"
                          value={eegView}
                          onChange={(e) => setEegView(e.target.value)}
                          size="sm"
                        >
                          <option value="stacked">Stacked</option>
                          <option value="overlay">Overlay</option>
                          {CHANNELS.map((ch) => (
                            <option key={ch.prefix} value={ch.prefix}>{ch.label}</option>
                          ))}
                        </Select>
                      </div>
                    </ControlGroup>
                    {events.length > 0 && (
                      <MarkerToggle on={markers.eeg} onToggle={() => toggleMarkers("eeg")} />
                    )}
                  </div>
                }
              />
              <div className="p-3 sm:p-4">
                <EegStripChart
                  samples={samples}
                  channels={eegChannels}
                  overlay={eegView === "overlay"}
                  events={chartEvents("eeg")}
                  onEventClick={setSelectedEvent}
                  onVisibleRangeChange={onEegRange}
                />
              </div>

              <div className="border-t border-border px-5 py-4">
                <div className="flex items-center justify-between mb-3">
                  <Label>Window statistics</Label>
                  <span className="font-mono text-[11px] text-muted tnum">
                    {range.from.toFixed(1)}s – {range.to.toFixed(1)}s
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {stats.map((ch) => (
                    <div
                      key={ch.key}
                      className={`rounded-xl border px-4 py-3 ${
                        ch.flat ? "border-crit/40 bg-crit-soft/30" : "border-border bg-inset/40"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: `var(${ch.color})` }} />
                        <span className="font-mono text-[12px] font-semibold text-ink">{ch.label}</span>
                        {ch.flat && <Pill tone="crit">No signal</Pill>}
                      </div>
                      {ch.flat ? (
                        <p className="text-[11px] leading-snug text-muted">
                          This electrode isn&apos;t picking up a signal — the line is flat (barely any
                          change: {fmtUv(ch.pkpk)} µV). Reseat it before the next session.
                        </p>
                      ) : (
                        <dl className="space-y-1">
                          <StatLine label="Mean" value={`${fmtUv(ch.mean)} µV`} />
                          <StatLine label="Peak (µV)" value={fmtUv(ch.peak)} />
                          <StatLine label="SD" value={fmtUv(ch.sd)} />
                        </dl>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            {bandError && !hasBands && (
              <Card className="p-6 flex items-center justify-center">
                <Alert tone="warn">{bandError}</Alert>
              </Card>
            )}

            {hasBands && (
              <>
                {/* ── Frequency bands (our FFT of the filtered EEG, not the SDK) ── */}
                {hasFft ? (
                <Card className="overflow-hidden">
                  <CardHeader
                    title="Frequency bands"
                    subtitle="How much energy is in each brainwave band (delta, theta, alpha, beta, gamma) over time. Stacked shows all four channels; pick one channel for a closer look."
                    actions={
                      <div className="flex flex-wrap items-end gap-3">
                        <ControlGroup label="Channel">
                          <div className="w-28">
                            <Select
                              aria-label="Channel"
                              value={channel}
                              onChange={(e) => setChannel(e.target.value)}
                              size="sm"
                              className="font-mono"
                            >
                              <option value="stacked">Stacked</option>
                              {CHANNELS.map((ch) => (
                                <option key={ch.prefix} value={ch.prefix}>{ch.label}</option>
                              ))}
                            </Select>
                          </div>
                        </ControlGroup>
                        {events.length > 0 && (
                          <MarkerToggle on={markers.bands} onToggle={() => toggleMarkers("bands")} />
                        )}
                      </div>
                    }
                  />
                  <div className="p-3 sm:p-4">
                    <TimeSeriesChart
                      samples={fftBandRows}
                      panels={bandPanels}
                      events={chartEvents("bands")}
                      onEventClick={setSelectedEvent}
                      onVisibleRangeChange={onBandRange}
                      height={channel === "stacked" ? 130 : 220}
                    />
                  </div>

                  {/* Value rail — also the relief for the two light-mode band hues
                      that sit under 3:1 on white. */}
                  <div className="border-t border-border px-5 py-4">
                    <div className="flex items-center justify-between mb-3">
                      <Label>
                        {bandMulti
                          ? "Mean power · all channels"
                          : `Mean power · ${CHANNELS.find((c) => c.prefix === channel)?.label}`}
                      </Label>
                      <span className="font-mono text-[11px] text-muted tnum">
                        {bandRange.from.toFixed(1)}s – {bandRange.to.toFixed(1)}s
                      </span>
                    </div>

                    {bandMulti ? (
                      // Four channels' worth of rail would be twenty tiles; the grid
                      // says the same thing once, and answers the question the
                      // multi-channel views exist for — which channel carries this.
                      <div className="overflow-x-auto">
                        <table className="w-full text-[12px] tnum">
                          <thead>
                            <tr className="text-muted">
                              <th className="text-left font-semibold py-2 pr-4">Channel</th>
                              {BANDS.map((b) => (
                                <th key={b.key} className="text-right font-semibold py-2 px-3">
                                  <span className="inline-flex items-center gap-1.5">
                                    <span
                                      className="h-2 w-2 rounded-sm"
                                      style={{ background: `var(${b.color})` }}
                                    />
                                    {b.greek} {b.label}
                                  </span>
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {bandGrid.map((ch) => (
                              <tr key={ch.prefix} className="border-t border-border">
                                <td className="py-2 pr-4 font-mono font-semibold text-ink">
                                  {ch.label}
                                </td>
                                {ch.values.map((v, i) => (
                                  <td
                                    key={BANDS[i].key}
                                    className="py-2 px-3 text-right font-mono text-ink"
                                  >
                                    {fmt(v, 2)}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                        {bandStats.map((b) => (
                          <div key={b.key} className="rounded-xl border border-border bg-inset/40 px-4 py-3">
                            <div className="flex items-center gap-2 mb-1.5">
                              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: `var(${b.color})` }} />
                              <span className="text-[12px] font-semibold text-ink">
                                {b.greek} {b.label}
                              </span>
                            </div>
                            <div className="font-mono text-[15px] font-semibold text-ink tnum">
                              {fmt(b.mean, 2)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                </Card>
                ) : bandError ? (
                  <Card className="p-6 flex items-center justify-center">
                    <Alert tone="warn">{bandError}</Alert>
                  </Card>
                ) : null}

                {/* ── Elliptic band statistics (ml_service) ─────────────────
                    Replaces the old spectral profile, which was derived from the
                    bridge's FFT power. These are µV AMPLITUDE statistics from an
                    elliptic bandpass — a different quantity from the µV² power in
                    the card above, so they get their own card and their own axis
                    and are never mixed with it. */}
                <Card className="overflow-hidden">
                  <CardHeader
                    title="Band strength"
                    subtitle={
                      (ellipticMeta
                        ? `How strong each brainwave band's signal is, in µV, measured every ` +
                          `${ellipticMeta.step_s}s in ${ellipticMeta.window_size_s}s windows (${ellipticMeta.windows} in total).`
                        : "How strong each brainwave band's signal is, in µV. Ready shortly after the session ends.") +
                      (ellipticRows.length && ellipticStatMatters && currentEllipticStat
                        ? ` Showing ${currentEllipticStat.label} — ${currentEllipticStat.hint}.`
                        : "")
                    }
                    actions={
                      ellipticRows.length ? (
                        <div className="flex flex-wrap items-end gap-3">
                          <ControlGroup label="View">
                            <div
                              role="group"
                              aria-label="Elliptic view"
                              className="inline-flex rounded-lg border border-border bg-inset/60 p-0.5"
                            >
                              {[
                                { key: "window", label: "By window" },
                                { key: "timeline", label: "Timeline" },
                              ].map((v) => (
                                <button
                                  key={v.key}
                                  onClick={() => setEllipticView(v.key)}
                                  aria-pressed={ellipticView === v.key}
                                  className={`px-2.5 py-1.5 rounded-md text-[12px] font-semibold transition-colors ${
                                    ellipticView === v.key
                                      ? "bg-surface text-ink shadow-sm"
                                      : "text-muted hover:text-ink"
                                  }`}
                                >
                                  {v.label}
                                </button>
                              ))}
                            </div>
                          </ControlGroup>

                          {/* Timeline-only here: a line chart draws one statistic at
                              a time, so this is the only place a chart is on screen
                              that this control could apply to. The window view's own
                              "All channels" equivalent sits inline next to the label
                              it controls, further down — right beside what changes
                              when you touch it, rather than up in the header where the
                              actual profile chart it affects isn't even in view yet.
                              Same ellipticStat state either way, so switching between
                              window and timeline never silently shows a different
                              statistic than the one just picked. */}
                          {ellipticView === "timeline" && (
                            <ControlGroup label="Statistic">
                              <div className="w-24">
                                <Select
                                  aria-label="Elliptic statistic"
                                  value={ellipticStat}
                                  onChange={(e) => setEllipticStat(e.target.value)}
                                  size="sm"
                                >
                                  {ELLIPTIC_STATS.map((s) => (
                                    <option key={s.key} value={s.key}>{s.label}</option>
                                  ))}
                                </Select>
                              </div>
                            </ControlGroup>
                          )}

                          <ControlGroup label="Channel">
                            <div className="w-24">
                              <Select
                                aria-label="Elliptic channel"
                                value={ellipticChannel}
                                onChange={(e) => setEllipticChannel(e.target.value)}
                                size="sm"
                                className="font-mono"
                              >
                                <option value="all">All</option>
                                {CHANNELS.map((ch) => (
                                  <option key={ch.prefix} value={ch.prefix}>{ch.label}</option>
                                ))}
                              </Select>
                            </div>
                          </ControlGroup>

                          {/* Markers need a time axis, so they are timeline-only too.
                              The window view names the stimulus in prose instead. */}
                          {ellipticView === "timeline" && events.length > 0 && (
                            <MarkerToggle
                              on={markers.elliptic}
                              onToggle={() => toggleMarkers("elliptic")}
                            />
                          )}
                        </div>
                      ) : null
                    }
                  />

                  {ellipticError ? (
                    <div className="p-5">
                      <Alert tone="crit">{ellipticError}</Alert>
                    </div>
                  ) : featuresStatus === "failed" ? (
                    // The worker ran and could not do it. It said why — show that,
                    // rather than a generic failure the technician cannot act on.
                    <div className="p-8 flex flex-col items-center gap-3 text-center">
                      <Alert tone="crit">Couldn&apos;t calculate band strength for this session.</Alert>
                      {featuresError && (
                        <p className="max-w-lg font-mono text-[11px] leading-relaxed text-muted">
                          {featuresError}
                        </p>
                      )}
                      <p className="max-w-md text-[12px] leading-relaxed text-muted">
                        Every other chart on this page comes straight from the headset and
                        isn&apos;t affected — only this one depends on a background calculation
                        that didn&apos;t finish.
                      </p>
                    </div>
                  ) : pollTimedOut ? (
                    <div className="p-8 flex flex-col items-center gap-3 text-center">
                      <Alert tone="warn">Still not ready after three minutes.</Alert>
                      <p className="max-w-md text-[12px] leading-relaxed text-muted">
                        This is taking longer than expected. It&apos;s still safe to wait — this
                        message just stops the page from checking forever.
                      </p>
                      <Button variant="subtle" onClick={() => window.location.reload()}>
                        Check again
                      </Button>
                    </div>
                  ) : ellipticComputing ? (
                    // Computing, for real — sessions.features_status says so, and the
                    // page is polling. The chart appears by itself when it lands.
                    <div className="p-10 flex flex-col items-center gap-3 text-center">
                      <Spinner size={26} className="text-accent" />
                      <span className="font-medium text-ink">
                        Calculating band strength…
                      </span>
                      <p className="max-w-md text-[12px] leading-relaxed text-muted">
                        This happens automatically after the recording ends and can take a minute
                        or two. The chart will appear here on its own — no need to reload.
                      </p>
                    </div>
                  ) : (
                    <>
                      {ellipticView === "window" ? (
                        <div className="p-4 sm:p-5 space-y-4">
                          {/* Stepper. window_number is the worker's own 1-based
                              counter — shown, but never used to index, so a skipped
                              window can't shift the whole inspector by one. */}
                          <div className="flex flex-wrap items-center gap-3">
                            <Button
                              variant="subtle"
                              onClick={() => setEllipticIdx((i) => Math.max(0, i - 1))}
                              disabled={ellipticIdx === 0}
                            >
                              ← Prev
                            </Button>
                            <div className="min-w-[13rem] text-center">
                              <div className="font-mono text-[15px] font-semibold text-ink tnum">
                                Window {ellipticWindow?.window_number ?? ellipticIdx + 1}
                                <span className="text-muted font-normal">
                                  {" "}
                                  of {ellipticRows.length}
                                </span>
                              </div>
                              <div className="font-mono text-[11px] text-muted tnum">
                                {ellipticWindow
                                  ? `${ellipticWindow.t_seconds.toFixed(2)}s – ${ellipticWindow.t_end.toFixed(2)}s`
                                  : "—"}
                              </div>
                            </div>
                            <Button
                              variant="subtle"
                              onClick={() =>
                                setEllipticIdx((i) => Math.min(ellipticRows.length - 1, i + 1))
                              }
                              disabled={ellipticIdx >= ellipticRows.length - 1}
                            >
                              Next →
                            </Button>

                            <input
                              type="range"
                              min={0}
                              max={Math.max(0, ellipticRows.length - 1)}
                              value={ellipticIdx}
                              onChange={(e) => setEllipticIdx(Number(e.target.value))}
                              aria-label="Window"
                              className="flex-1 min-w-[10rem] accent-[var(--accent)]"
                            />
                          </div>

                          {/* What was on screen. A window straddling two stimuli
                              belongs cleanly to neither — say "between stimuli"
                              rather than attributing it to whichever is nearest. */}
                          <div className="flex items-center gap-2">
                            {ellipticWindowEvent ? (
                              <button
                                onClick={() =>
                                  setSelectedEvent(events.indexOf(ellipticWindowEvent))
                                }
                                className="text-[12px] font-semibold text-accent hover:underline"
                              >
                                Showing: {ellipticWindowEvent.label} →
                              </button>
                            ) : (
                              <span className="text-[12px] text-muted">
                                Between stimuli — no image or question on screen.
                              </span>
                            )}
                          </div>

                          <div>
                            <div className="mb-1 flex flex-wrap items-center gap-2 px-2">
                              {ellipticAll ? (
                                <>
                                  {/* The picker sits right in the sentence it
                                      controls — "[SD ▾] amplitude by channel…" —
                                      rather than up in the card header, out of
                                      sight of the chart it actually changes. Same
                                      ellipticStat as the timeline's own header
                                      control, so picking one here and switching
                                      views doesn't silently show a different
                                      statistic there. */}
                                  <div className="w-20">
                                    <Select
                                      aria-label="Statistic"
                                      value={ellipticStat}
                                      onChange={(e) => setEllipticStat(e.target.value)}
                                      size="sm"
                                    >
                                      {ELLIPTIC_STATS.map((s) => (
                                        <option key={s.key} value={s.key}>{s.label}</option>
                                      ))}
                                    </Select>
                                  </div>
                                  <Label>amplitude by channel · this window only (µV)</Label>
                                </>
                              ) : (
                                <Label>
                                  {CHANNELS.find((c) => c.prefix === ellipticChannel)?.label} · SD, peak and
                                  mean · this window only (µV)
                                </Label>
                              )}
                            </div>

                            <BandProfileChart groups={ellipticWindowProfile} bands={BANDS} />

                            {!ellipticAll && (
                              <p className="px-2 pt-1 text-[11px] leading-snug text-muted">
                                SD, Peak and Mean use different scales, so don&apos;t compare their
                                bar heights to each other — compare each one across bands instead.
                                Mean is expected to sit near zero; that&apos;s normal, not an error.
                              </p>
                            )}
                            {ellipticAll && ellipticStat === "mean" && (
                              <p className="px-2 pt-1 text-[11px] leading-snug text-muted">
                                Mean is close to zero for every band and channel here — that&apos;s
                                expected, not a sign of a missing signal. Switch to SD to see the
                                actual signal strength.
                              </p>
                            )}
                          </div>

                          {/* Every statistic for the selected channel, in one table —
                              no toggling, because all fifteen numbers fit. SD is the
                              amplitude; peak is the largest excursion in the window
                              (and carries the electrode artefacts); mean sits at ~0 for
                              every band because the signal is bandpassed before the
                              statistic is taken, which the header states rather than
                              leaving as a puzzle. */}
                          <div className="overflow-x-auto">
                            {ellipticAll ? (
                              // All channels: one statistic at a time, following the
                              // same selector as the chart above — a table showing SD
                              // under a chart showing peak would just be a trap.
                              <table className="w-full text-[12px] tnum">
                                <thead>
                                  <tr className="text-muted">
                                    <th className="text-left font-semibold py-2 pr-4">
                                      {currentEllipticStat?.label}{" "}
                                      µV · channel
                                    </th>
                                    {BANDS.map((b) => (
                                      <th
                                        key={b.key}
                                        className="text-right font-semibold py-2 px-3"
                                      >
                                        <span className="inline-flex items-center gap-1.5">
                                          <span
                                            className="h-2 w-2 rounded-sm"
                                            style={{ background: `var(${b.color})` }}
                                          />
                                          {b.greek} {b.label}
                                        </span>
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {CHANNELS.map((ch) => (
                                    <tr key={ch.prefix} className="border-t border-border">
                                      <td className="py-2 pr-4 font-mono font-semibold text-ink">
                                        {ch.label}
                                      </td>
                                      {BANDS.map((b) => (
                                        <td
                                          key={b.key}
                                          className="py-2 px-3 text-right font-mono text-ink"
                                        >
                                          {fmtUv(
                                            ellipticWindow?.[
                                              `${ch.prefix}_${b.key}_${ellipticStat}`
                                            ]
                                          )}
                                        </td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            ) : (
                              // One channel: every statistic fits, so none is hidden behind
                              // a toggle. Mean is labelled for what it is in its own header,
                              // so its zeros read as expected rather than as broken data.
                              <table className="w-full text-[12px] tnum">
                                <thead>
                                  <tr className="text-muted">
                                    <th className="text-left font-semibold py-2 pr-4">
                                      {CHANNELS.find((c) => c.prefix === ellipticChannel)?.label} ·
                                      band
                                    </th>
                                    <th className="text-right font-semibold py-2 px-3">
                                      SD µV
                                      <span className="block text-[10px] font-normal">
                                        typical strength
                                      </span>
                                    </th>
                                    <th className="text-right font-semibold py-2 px-3">
                                      Peak µV
                                      <span className="block text-[10px] font-normal">
                                        biggest spike
                                      </span>
                                    </th>
                                    <th className="text-right font-semibold py-2 px-3">
                                      Mean µV
                                      <span className="block text-[10px] font-normal">
                                        usually near zero
                                      </span>
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {BANDS.map((b) => (
                                    <tr key={b.key} className="border-t border-border">
                                      <td className="py-2 pr-4">
                                        <span className="inline-flex items-center gap-2">
                                          <span
                                            className="h-2.5 w-2.5 rounded-sm"
                                            style={{ background: `var(${b.color})` }}
                                          />
                                          <span className="font-semibold text-ink">
                                            {b.greek} {b.label}
                                          </span>
                                        </span>
                                      </td>
                                      <td className="py-2 px-3 text-right font-mono font-semibold text-ink">
                                        {fmtUv(ellipticWindow?.[`${ellipticChannel}_${b.key}_std`])}
                                      </td>
                                      <td className="py-2 px-3 text-right font-mono text-ink">
                                        {fmtUv(ellipticWindow?.[`${ellipticChannel}_${b.key}_peak`])}
                                      </td>
                                      <td className="py-2 px-3 text-right font-mono text-muted">
                                        {fmtUv(ellipticWindow?.[`${ellipticChannel}_${b.key}_mean`])}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="p-3 sm:p-4">
                          <TimeSeriesChart
                            samples={ellipticRows}
                            panels={ellipticPanels}
                            events={chartEvents("elliptic")}
                            onEventClick={setSelectedEvent}
                            onVisibleRangeChange={onEllipticRange}
                            height={ellipticAll ? 130 : 220}
                          />
                        </div>
                      )}

                      {/* Only on the timeline: there, choosing Mean gives five traces
                          flat along zero and no explanation. The window view's table
                          says the same thing in its own column header. */}
                      {ellipticView === "timeline" && ellipticStat === "mean" && (
                        <div className="px-5 pb-2">
                          <Alert tone="warn">
                            Mean is close to zero for every band here — that&apos;s expected, not a
                            sign of a missing signal. Switch to SD to see the actual signal
                            strength.
                          </Alert>
                        </div>
                      )}

                      {ellipticView === "timeline" && ellipticAxis.clipped > 0 && (
                        <div className="px-5 pb-2">
                          <Alert tone="warn">
                            The chart&apos;s scale is capped at {fmtUv(ellipticAxis.max)} µV so a
                            few extreme spikes don&apos;t squash everything else flat.{" "}
                            {ellipticAxis.clipped}{" "}
                            {ellipticAxis.clipped === 1 ? "reading" : "readings"} go above that,
                            peaking at {fmtUv(ellipticAxis.maxValue)} µV — almost certainly
                            electrode noise, not real brain signal. Use &ldquo;By window&rdquo; to
                            look at them one at a time.
                          </Alert>
                        </div>
                      )}

                      {ellipticDead.length > 0 && (
                        <div className="px-5 pb-2">
                          <Alert tone="warn">
                            {ellipticDead.join(" and ")}{" "}
                            {ellipticDead.length === 1 ? "isn't" : "aren't"} picking up a real
                            signal — the flat line here doesn&apos;t mean the reading is zero, it
                            means there&apos;s nothing to measure. Reseat the electrode before the
                            next session.
                          </Alert>
                        </div>
                      )}

                      {/* Averages over the chart's visible range — meaningless in
                          the single-window view, which has no range. */}
                      {ellipticView === "timeline" && (
                        <>
                          {ellipticStats.length > 0 && (
                            <div className="border-t border-border px-5 py-4">
                              <div className="flex items-center justify-between mb-3">
                                <Label>
                                  {ELLIPTIC_STATS.find((s) => s.key === ellipticStat)?.label}{" "}
                                  amplitude ·{" "}
                                  {CHANNELS.find((c) => c.prefix === ellipticChannel)?.label}
                                </Label>
                                <span className="font-mono text-[11px] text-muted tnum">
                                  {ellipticRange.from.toFixed(1)}s – {ellipticRange.to.toFixed(1)}s
                                </span>
                              </div>
                              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                                {ellipticStats.map((b) => (
                                  <div
                                    key={b.key}
                                    className="rounded-xl border border-border bg-inset/40 px-4 py-3"
                                  >
                                    <div className="flex items-center gap-2 mb-1.5">
                                      <span
                                        className="h-2.5 w-2.5 rounded-sm"
                                        style={{ background: `var(${b.color})` }}
                                      />
                                      <span className="text-[12px] font-semibold text-ink">
                                        {b.greek} {b.label}
                                      </span>
                                    </div>
                                    <div className="font-mono text-[15px] font-semibold text-ink tnum">
                                      {fmtUv(b.mean)}
                                      <span className="ml-1 text-[11px] font-normal text-muted">
                                        µV
                                      </span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          <div className="border-t border-border px-3 sm:px-4 py-4">
                            <div className="px-2 mb-1">
                              <Label>
                                {ellipticAll
                                  ? `Amplitude by channel · visible window · ${
                                      ELLIPTIC_STATS.find((s) => s.key === ellipticStat)?.label
                                    } µV`
                                  : `${
                                      CHANNELS.find((c) => c.prefix === ellipticChannel)?.label
                                    } · SD, peak and mean · visible window (µV)`}
                              </Label>
                            </div>
                            <BandProfileChart groups={ellipticProfile} bands={BANDS} />
                          </div>
                        </>
                      )}
                    </>
                  )}
                </Card>

                {/* ── Mental state ─────────────────────────────────────────── */}
                <Card className="overflow-hidden">
                  <CardHeader
                    title="Mental state"
                    subtitle="How attentive, relaxed, and mentally loaded the headset estimates the client was, on a scale from 0 to 1."
                    actions={
                      <div className="flex flex-wrap items-center gap-2">
                        {qualityStat?.mean != null && (
                          <Pill tone={qualityStat.mean >= 70 ? "good" : qualityStat.mean >= 40 ? "warn" : "crit"}>
                            Signal quality {fmt(qualityStat.mean, 0)}/100
                          </Pill>
                        )}
                        {events.length > 0 && (
                          <MarkerToggle
                            on={markers.mental}
                            onToggle={() => toggleMarkers("mental")}
                          />
                        )}
                      </div>
                    }
                  />
                  <div className="p-3 sm:p-4">
                    <TimeSeriesChart
                      samples={bandRows}
                      panels={mentalPanels}
                      events={chartEvents("mental")}
                      onEventClick={setSelectedEvent}
                      onVisibleRangeChange={onMentalRange}
                      height={220}
                    />
                  </div>
                  <div className="border-t border-border px-5 py-4">
                    <div className="flex items-center justify-between mb-3">
                      <Label>Window averages</Label>
                      <span className="font-mono text-[11px] text-muted tnum">
                        {mentalRange.from.toFixed(1)}s – {mentalRange.to.toFixed(1)}s
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {mentalStats.map((m) => (
                        <div key={m.key} className="rounded-xl border border-border bg-inset/40 px-4 py-3">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: `var(${m.color})` }} />
                            <span className="text-[12px] font-semibold text-ink">{m.label}</span>
                          </div>
                          <div className="font-mono text-[20px] font-semibold text-ink tnum leading-none mb-2">
                            {fmt(m.mean, 2)}
                            <span className="text-[12px] font-normal text-muted"> / 1.00</span>
                          </div>
                          <dl className="space-y-1">
                            <StatLine label="Range" value={`${fmt(m.min, 2)} – ${fmt(m.max, 2)}`} />
                          </dl>
                        </div>
                      ))}
                    </div>
                  </div>
                </Card>

                {/* ── Vitals ───────────────────────────────────────────────── */}
                <Card className="overflow-hidden">
                  <CardHeader
                    title="Vitals"
                    subtitle="Heart rate and blood-oxygen level, shown on separate scales since they use different units."
                    actions={
                      vitalPanels.length > 0 && events.length > 0 ? (
                        <MarkerToggle
                          on={markers.vitals}
                          onToggle={() => toggleMarkers("vitals")}
                        />
                      ) : null
                    }
                  />
                  {vitalPanels.length === 0 ? (
                    <div className="px-5 py-8 flex items-center justify-center">
                      <Alert tone="warn">
                        No heart-rate or blood-oxygen readings were recorded for this session.
                      </Alert>
                    </div>
                  ) : (
                    <>
                      <div className="p-3 sm:p-4">
                        <TimeSeriesChart
                          samples={bandRows}
                          panels={vitalPanels}
                          events={chartEvents("vitals")}
                          onEventClick={setSelectedEvent}
                          onVisibleRangeChange={onVitalsRange}
                          height={170}
                        />
                      </div>
                      <div className="border-t border-border px-5 py-4">
                        <div className="flex items-center justify-between mb-3">
                          <Label>Window averages</Label>
                          <span className="font-mono text-[11px] text-muted tnum">
                            {vitalsRange.from.toFixed(1)}s – {vitalsRange.to.toFixed(1)}s
                          </span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {hrStats && (
                            <VitalTile
                              label="Heart rate"
                              color="--vital-hr"
                              value={fmt(hrStats.mean, 0)}
                              unit="bpm"
                              min={fmt(hrStats.min, 0)}
                              max={fmt(hrStats.max, 0)}
                            />
                          )}
                          {spo2Stats && (
                            <VitalTile
                              label="SpO₂"
                              color="--vital-spo2"
                              value={fmt(spo2Stats.mean, 0)}
                              unit="%"
                              min={fmt(spo2Stats.min, 0)}
                              max={fmt(spo2Stats.max, 0)}
                            />
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </Card>
              </>
            )}
          </>
        )}
      </div>

      {selectedEvent != null && events[selectedEvent] && (
        <StimulusModal event={events[selectedEvent]} onClose={() => setSelectedEvent(null)} />
      )}
    </main>
  );
}

function StatLine({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="font-mono text-[12px] font-semibold text-ink tnum">{value}</dd>
    </div>
  );
}

function VitalTile({ label, color, value, unit, min, max }) {
  return (
    <div className="rounded-xl border border-border bg-inset/40 px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: `var(${color})` }} />
        <span className="text-[12px] font-semibold text-ink">{label}</span>
      </div>
      <div className="font-mono text-[24px] font-semibold text-ink tnum leading-none mb-2">
        {value}
        <span className="text-[12px] font-normal text-muted"> {unit}</span>
      </div>
      <StatLine label="Range" value={`${min} – ${max} ${unit}`} />
    </div>
  );
}
