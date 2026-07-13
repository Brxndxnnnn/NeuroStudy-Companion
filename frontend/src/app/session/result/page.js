"use client";
import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  getSession,
  getSessionResultsFiltered,
  getSessionResultsBandPower,
  getSessionResultEvents,
} from "@/utils/api";
import { SessionTopBar } from "@/components/TopNav";
import { Card, CardHeader, Button, Label, Pill, Alert, Spinner } from "@/components/ui";
import EegStripChart from "@/components/EegStripChart";
import TimeSeriesChart from "@/components/TimeSeriesChart";
import BandProfileChart from "@/components/BandProfileChart";

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

function channelStats(samples, key, from, to) {
  const start = lowerBound(samples, from);
  const end = lowerBound(samples, to);
  let sum = 0, peak = 0, count = 0;
  for (let i = start; i < end; i++) {
    const v = samples[i][key];
    if (v == null || Number.isNaN(v)) continue;
    sum += v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
    count++;
  }
  if (!count) return { mean: null, peak: null, sd: null, count: 0 };
  const mean = sum / count;
  let sq = 0;
  for (let i = start; i < end; i++) {
    const v = samples[i][key];
    if (v == null || Number.isNaN(v)) continue;
    sq += (v - mean) * (v - mean);
  }
  return { mean, peak, sd: Math.sqrt(sq / count), count };
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

function fmtDuration(sec) {
  if (!sec || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Event rows → chart marker windows on the session's t_seconds axis. Handles both
// the rich /results rows (url, prompt, per-event averages) and the slimmer
// events_timing rows bundled with /results/filtered, which this falls back to.
// Images and questions are numbered independently ("Image 3", "Question 2").
function buildEventWindows(rows, startTime, durSec) {
  const startMs = new Date(startTime).getTime();
  const out = [];
  let nImg = 0;
  let nQ = 0;
  for (const r of rows || []) {
    const type = r.stimulus_type || (r.image_id != null ? "image" : "question");
    const label = type === "image" ? `Image ${++nImg}` : `Question ${++nQ}`;
    const from = (new Date(r.shown_at).getTime() - startMs) / 1000;
    // hidden_at is coalesced server-side (next event / session end), but a still-
    // open window would collapse the band to zero width — give it a visible span.
    let to = r.hidden_at ? (new Date(r.hidden_at).getTime() - startMs) / 1000 : from + 1;
    if (!(to > from)) to = from + 0.5;
    if (Number.isNaN(from) || to <= 0 || from >= durSec) continue;
    out.push({ ...r, type, label, from: Math.max(0, from), to: Math.min(durSec, to) });
  }
  return out;
}

export default function SessionResults() {
  const router = useRouter();
  const [samples, setSamples] = useState([]);
  const [bandRows, setBandRows] = useState([]);
  const [bandError, setBandError] = useState("");
  const [events, setEvents] = useState([]);
  const [selectedEvent, setSelectedEvent] = useState(null);
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
        const [fRes, bRes, eRes] = await Promise.all([
          getSessionResultsFiltered(sessionId, 0, Math.ceil(durSec) + 1),
          getSessionResultsBandPower(sessionId).catch(() => null),
          getSessionResultEvents(sessionId).catch(() => null),
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

        if (!bRes || !bRes.ok) {
          setBandError("Failed to load band powers, mental state and vitals.");
        } else {
          const bData = await bRes.json();
          const bRows = bData.samples || [];
          if (bRows.length === 0) {
            setBandError("No band-power rows were recorded for this session.");
          } else {
            const span = { from: bRows[0].t_seconds, to: bRows[bRows.length - 1].t_seconds };
            setBandRows(bRows);
            setBandRange(span);
            setMentalRange(span);
            setVitalsRange(span);
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

  const onEegRange = useCallback((from, to) => setRange({ from, to }), []);
  const onBandRange = useCallback((from, to) => setBandRange({ from, to }), []);
  const onMentalRange = useCallback((from, to) => setMentalRange({ from, to }), []);
  const onVitalsRange = useCallback((from, to) => setVitalsRange({ from, to }), []);

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
  const bandPanels = useMemo(
    () => [
      {
        label: "Power",
        unit: "",
        series: BANDS.map((b) => ({ key: `${channel}_${b.key}`, label: b.label, color: b.color })),
      },
    ],
    [channel]
  );

  const bandStats = useMemo(() => {
    if (!bandRows.length) return [];
    return BANDS.map((b) => ({
      ...b,
      ...seriesStats(bandRows, `${channel}_${b.key}`, bandRange.from, bandRange.to),
    }));
  }, [bandRows, channel, bandRange]);

  // Cross-channel spectral profile for the visible window.
  const bandProfile = useMemo(() => {
    if (!bandRows.length) return [];
    return CHANNELS.map((ch) => ({
      label: ch.label,
      values: Object.fromEntries(
        BANDS.map((b) => [
          b.key,
          seriesStats(bandRows, `${ch.prefix}_${b.key}`, bandRange.from, bandRange.to).mean,
        ])
      ),
    }));
  }, [bandRows, bandRange]);

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
  const hasBands = bandRows.length > 0;

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
                    ? "µV. Drag to zoom, scroll to pan — the stats update to the visible window. Shaded bands mark stimuli (teal = image, amber = question); click one to see what was shown."
                    : "µV. Drag to zoom, scroll to pan — the stats update to the visible window."
                }
                actions={
                  <div
                    role="group"
                    aria-label="EEG view"
                    className="inline-flex rounded-lg border border-border bg-inset/60 p-0.5"
                  >
                    {[
                      { id: "stacked", label: "Stacked" },
                      { id: "overlay", label: "Overlay" },
                      ...CHANNELS.map((ch) => ({ id: ch.prefix, label: ch.label })),
                    ].map((v) => (
                      <button
                        key={v.id}
                        onClick={() => setEegView(v.id)}
                        aria-pressed={eegView === v.id}
                        className={`px-2.5 py-1.5 rounded-md text-[12px] font-semibold transition-colors ${
                          eegView === v.id ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
                        }`}
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>
                }
              />
              <div className="p-3 sm:p-4">
                <EegStripChart
                  samples={samples}
                  channels={eegChannels}
                  overlay={eegView === "overlay"}
                  events={events}
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
                    <div key={ch.key} className="rounded-xl border border-border bg-inset/40 px-4 py-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: `var(${ch.color})` }} />
                        <span className="font-mono text-[12px] font-semibold text-ink">{ch.label}</span>
                      </div>
                      <dl className="space-y-1">
                        <StatLine label="Mean" value={`${fmt(ch.mean)} µV`} />
                        <StatLine label="Peak |µV|" value={fmt(ch.peak)} />
                        <StatLine label="SD" value={fmt(ch.sd)} />
                      </dl>
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
                {/* ── Frequency bands ──────────────────────────────────────── */}
                <Card className="overflow-hidden">
                  <CardHeader
                    title="Frequency bands"
                    subtitle="Band power per channel at 1 Hz. Pick a channel for the timeline; the profile below compares all four."
                    actions={
                      <div
                        role="group"
                        aria-label="Channel"
                        className="inline-flex rounded-lg border border-border bg-inset/60 p-0.5"
                      >
                        {CHANNELS.map((ch) => (
                          <button
                            key={ch.prefix}
                            onClick={() => setChannel(ch.prefix)}
                            aria-pressed={channel === ch.prefix}
                            className={`px-3 py-1.5 rounded-md font-mono text-[12px] font-semibold transition-colors ${
                              channel === ch.prefix
                                ? "bg-surface text-ink shadow-sm"
                                : "text-muted hover:text-ink"
                            }`}
                          >
                            {ch.label}
                          </button>
                        ))}
                      </div>
                    }
                  />
                  <div className="p-3 sm:p-4">
                    <TimeSeriesChart
                      samples={bandRows}
                      panels={bandPanels}
                      onVisibleRangeChange={onBandRange}
                      height={220}
                    />
                  </div>

                  {/* Value rail — also the relief for the two light-mode band hues
                      that sit under 3:1 on white. */}
                  <div className="border-t border-border px-5 py-4">
                    <div className="flex items-center justify-between mb-3">
                      <Label>Mean power · {CHANNELS.find((c) => c.prefix === channel)?.label}</Label>
                      <span className="font-mono text-[11px] text-muted tnum">
                        {bandRange.from.toFixed(1)}s – {bandRange.to.toFixed(1)}s
                      </span>
                    </div>
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
                  </div>

                  <div className="border-t border-border px-3 sm:px-4 py-4">
                    <div className="px-2 mb-1">
                      <Label>Spectral profile by channel · visible window</Label>
                    </div>
                    <BandProfileChart groups={bandProfile} bands={BANDS} />
                  </div>
                </Card>

                {/* ── Mental state ─────────────────────────────────────────── */}
                <Card className="overflow-hidden">
                  <CardHeader
                    title="Mental state"
                    subtitle="Attention, relaxation and workload on the headset's 0–1 index."
                    actions={
                      qualityStat?.mean != null ? (
                        <Pill tone={qualityStat.mean >= 70 ? "good" : qualityStat.mean >= 40 ? "warn" : "crit"}>
                          Signal quality {fmt(qualityStat.mean, 0)}/100
                        </Pill>
                      ) : null
                    }
                  />
                  <div className="p-3 sm:p-4">
                    <TimeSeriesChart
                      samples={bandRows}
                      panels={mentalPanels}
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
                    subtitle="Heart rate and blood-oxygen saturation, each on its own scale."
                  />
                  {vitalPanels.length === 0 ? (
                    <div className="px-5 py-8 flex items-center justify-center">
                      <Alert tone="warn">
                        No heart-rate or SpO₂ readings were recorded for this session.
                      </Alert>
                    </div>
                  ) : (
                    <>
                      <div className="p-3 sm:p-4">
                        <TimeSeriesChart
                          samples={bandRows}
                          panels={vitalPanels}
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

// Click-through from an event band: the image (or math question) that was on
// screen during that window, plus the band-power averages recorded while it showed.
function StimulusModal({ event, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isImage = event.type === "image";
  const averages = [
    { label: "Attention", value: event.avg_attention, digits: 2 },
    { label: "Relaxation", value: event.avg_relaxation, digits: 2 },
    { label: "Workload", value: event.avg_mental_workload, digits: 2 },
    { label: "Heart rate", value: event.avg_heart_rate, digits: 0, unit: "bpm" },
    { label: "SpO₂", value: event.avg_spo2, digits: 0, unit: "%" },
  ].filter((a) => a.value != null);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-4 sm:p-8 bg-black/50 anim-fade"
      role="dialog"
      aria-modal="true"
      aria-label={event.label}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-border bg-surface shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <span className="font-semibold text-ink">{event.label}</span>
            {event.category && <Pill tone="neutral">{event.category}</Pill>}
            {event.difficulty && <Pill tone="neutral">{event.difficulty}</Pill>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:text-ink hover:bg-inset transition-colors"
          >
            ✕
          </button>
        </div>

        {isImage ? (
          <div className="bg-inset grid place-items-center">
            {event.url ? (
              <img
                src={event.url}
                alt={event.filename || event.label}
                className="max-h-[55vh] w-full object-contain"
              />
            ) : (
              <p className="py-14 text-muted text-sm">Image details unavailable for this event.</p>
            )}
          </div>
        ) : (
          <div className="px-6 py-12 text-center">
            {event.prompt ? (
              <p className="font-mono text-3xl font-semibold text-ink tnum">{event.prompt}</p>
            ) : (
              <p className="text-muted text-sm">Question details unavailable for this event.</p>
            )}
          </div>
        )}

        <div className="px-5 py-4 border-t border-border flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <span className="font-mono text-[12px] text-muted tnum">
            Shown {event.from.toFixed(1)}s – {event.to.toFixed(1)}s · {(event.to - event.from).toFixed(1)}s
          </span>
          {averages.length > 0 && (
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {averages.map((a) => (
                <span key={a.label} className="text-[12px] text-muted">
                  {a.label}{" "}
                  <b className="font-mono text-ink tnum">
                    {Number(a.value).toFixed(a.digits)}
                    {a.unit ? ` ${a.unit}` : ""}
                  </b>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
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
