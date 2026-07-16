"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  getPhase1Status,
  getPhase1Model,
  getPhase1Sessions,
  getPhase1Predictions,
} from "@/utils/api";
import TopNav from "@/components/TopNav";
import TimeSeriesChart from "@/components/TimeSeriesChart";
import {
  PageContainer,
  PageHeading,
  Card,
  CardHeader,
  StatCard,
  Pill,
  Alert,
  Spinner,
  Button,
  Select,
} from "@/components/ui";

/* Progress toward the distinct-image floor needed before training is meaningful. */
function ReadinessBar({ value, target }) {
  const pct = target > 0 ? Math.min(100, Math.round((value / target) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-semibold text-ink">
          {value} <span className="text-muted font-normal">/ {target} distinct images</span>
        </span>
        <span className="font-mono text-[12px] text-muted tnum">{pct}%</span>
      </div>
      <div className="mt-2 h-2.5 w-full rounded-full bg-inset overflow-hidden">
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function PipelineStep({ done, children }) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
          done ? "bg-good-soft text-good" : "bg-inset text-muted"
        }`}
      >
        {done ? "✓" : "•"}
      </span>
      <span className="text-[13.5px] text-ink-2 leading-relaxed">{children}</span>
    </li>
  );
}

const fmt = (n, d = 2) => (n == null || Number.isNaN(n) ? "—" : Number(n).toFixed(d));
const shortId = (id) => (id ? id.slice(0, 8) : "");

export default function InsightsPage() {
  const router = useRouter();
  const [status, setStatus] = useState(null);
  const [model, setModel] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [selectedSession, setSelectedSession] = useState("");
  const [predictions, setPredictions] = useState(null);
  const [predLoading, setPredLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [sRes, mRes, seRes] = await Promise.all([
        getPhase1Status(),
        getPhase1Model(),
        getPhase1Sessions(),
      ]);
      if (sRes.ok) setStatus(await sRes.json());
      else setError("Could not reach the ML service. It may still be starting up.");
      if (mRes.ok) setModel(await mRes.json());
      if (seRes.ok) {
        const data = await seRes.json();
        setSessions(data.sessions || []);
      }
    } catch {
      setError("Could not reach the ML service. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  const loadPredictions = async (sessionId) => {
    setSelectedSession(sessionId);
    setPredictions(null);
    if (!sessionId) return;
    setPredLoading(true);
    try {
      const res = await getPhase1Predictions(sessionId);
      if (res.ok) setPredictions(await res.json());
    } catch {
      /* leave predictions null → chart shows empty state */
    } finally {
      setPredLoading(false);
    }
  };

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const data = status?.data || {};
  const readiness = status?.readiness || {};
  const current = model?.current || null;
  const trained = !!current;

  const predSamples = (predictions?.predictions || []).map((p) => ({
    t_seconds: Number(p.t_seconds),
    valence: p.pred_valence,
    arousal: p.pred_arousal,
    actual_valence: p.actual_valence,
    actual_arousal: p.actual_arousal,
  }));

  return (
    <>
      <TopNav />
      <main className="py-8">
        <PageContainer>
          <PageHeading
            title="Insights"
            subtitle="EEG → emotion model · Phase 1 (valence & arousal)"
            actions={
              <Button variant="ghost" onClick={load} disabled={loading}>
                {loading ? "Refreshing…" : "Refresh"}
              </Button>
            }
          />

          {loading && !status ? (
            <div className="mt-10 flex items-center gap-3 text-muted">
              <Spinner size={18} />
              <span className="text-sm">Loading model status…</span>
            </div>
          ) : error ? (
            <Alert tone="crit" className="mt-6">{error}</Alert>
          ) : (
            <div className="mt-6 space-y-6">
              {/* Model status */}
              <Card>
                <CardHeader
                  title="Model status"
                  subtitle="A supervised model predicting OASIS valence & arousal from 2 s of filtered EEG."
                  actions={
                    trained ? (
                      <Pill tone="good" dot>Trained · v{current.model_version}</Pill>
                    ) : (
                      <Pill tone="warn" dot>Not trained yet</Pill>
                    )
                  }
                />
                <div className="px-6 py-5">
                  {trained ? (
                    <>
                      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
                        <Metric label="Algorithm" value={current.algo} />
                        <Metric label="Trained on" value={`${current.n_epochs ?? "—"} epochs`} hint={`${current.n_distinct_images ?? "—"} images · ${current.n_sessions ?? "—"} sessions`} />
                        <Metric label="Valence R²" value={fmt(current.cv_r2_valence)} hint={`null ${fmt(current.null_r2_valence)}`} />
                        <Metric label="Arousal R²" value={fmt(current.cv_r2_arousal)} hint={`null ${fmt(current.null_r2_arousal)}`} />
                      </div>
                      {(current.cv_r2_valence != null && current.cv_r2_valence <= (current.null_r2_valence ?? -Infinity)) && (
                        <Alert tone="warn" className="mt-5">
                          This model does not beat the predict-the-mean baseline — expected
                          with the current tiny dataset. The pipeline is proven; accuracy
                          will follow once sessions are recorded over OASIS imagery.
                        </Alert>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-ink-2 leading-relaxed">{readiness.message}</p>
                      <div className="mt-5 max-w-md">
                        <ReadinessBar
                          value={data.distinct_labelled_images || 0}
                          target={readiness.distinct_images_target || 30}
                        />
                      </div>
                    </>
                  )}
                </div>
              </Card>

              {/* Per-session predictions */}
              <Card>
                <CardHeader
                  title="Session predictions"
                  subtitle="Predicted emotional trajectory across a recorded session."
                  actions={
                    <Select
                      className="min-w-[240px]"
                      value={selectedSession}
                      onChange={(e) => loadPredictions(e.target.value)}
                    >
                      <option value="">Select a session…</option>
                      {sessions.map((s) => (
                        <option key={s.session_id} value={s.session_id}>
                          {shortId(s.session_id)} · {new Date(s.start_time).toLocaleDateString()}
                          {s.n_predictions ? ` · ${s.n_predictions} pts` : " · no predictions"}
                        </option>
                      ))}
                    </Select>
                  }
                />
                <div className="px-6 py-5">
                  {!trained ? (
                    <p className="text-sm text-muted">Train a model to generate predictions.</p>
                  ) : !selectedSession ? (
                    <p className="text-sm text-muted">Pick a session to see its predicted valence & arousal over time.</p>
                  ) : predLoading ? (
                    <div className="flex items-center gap-3 text-muted">
                      <Spinner size={16} /><span className="text-sm">Loading predictions…</span>
                    </div>
                  ) : predSamples.length === 0 ? (
                    <p className="text-sm text-muted">
                      No predictions for this session — its EEG yielded no usable epochs
                      (dead electrodes or no bounded image windows).
                    </p>
                  ) : (
                    <TimeSeriesChart
                      samples={predSamples}
                      height={150}
                      panels={[
                        { label: "Valence · predicted vs actual", unit: "", min: 1, max: 7,
                          series: [
                            { key: "valence", label: "Predicted", color: "--accent" },
                            { key: "actual_valence", label: "Actual (OASIS)", color: "--muted" },
                          ] },
                        { label: "Arousal · predicted vs actual", unit: "", min: 1, max: 7,
                          series: [
                            { key: "arousal", label: "Predicted", color: "--warn" },
                            { key: "actual_arousal", label: "Actual (OASIS)", color: "--muted" },
                          ] },
                      ]}
                    />
                  )}
                </div>
              </Card>

              {/* Data coverage */}
              <div>
                <h2 className="mb-3 text-[13px] font-semibold text-ink">Training data collected</h2>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                  <StatCard label="Completed sessions" value={data.sessions_completed ?? "—"} hint="Recorded & finalised" />
                  <StatCard label="OASIS images labelled" value={data.oasis_images_labelled ?? "—"} hint="Have valence/arousal norms" />
                  <StatCard label="Sessions with OASIS EEG" value={data.sessions_with_oasis_eeg ?? "—"} hint="EEG over labelled images" />
                  <StatCard label="Distinct labelled images" value={data.distinct_labelled_images ?? "—"} hint="Seen in recorded EEG" />
                  <StatCard label="Labelled image events" value={data.labelled_image_events ?? "—"} hint="Epoch source windows" />
                </div>
              </div>

              {/* Path to a trained model */}
              <Card>
                <CardHeader
                  title="Path to a generalising model"
                  subtitle="The flow runs end-to-end now; accuracy is gated on data collection."
                />
                <ul className="space-y-3 px-6 py-5">
                  <PipelineStep done={(data.oasis_images_labelled || 0) > 0}>
                    <strong className="font-semibold text-ink">OASIS labels loaded.</strong>{" "}
                    Each image carries a population-normed valence & arousal rating — the training target.
                  </PipelineStep>
                  <PipelineStep done={(data.sessions_with_oasis_eeg || 0) > 0}>
                    <strong className="font-semibold text-ink">Record sessions over OASIS images.</strong>{" "}
                    Stimulus sets must be built from labelled OASIS images (not the placeholder set).
                  </PipelineStep>
                  <PipelineStep done={trained}>
                    <strong className="font-semibold text-ink">Train a model.</strong>{" "}
                    Fits ridge / random-forest with GroupKFold-by-image against a predict-the-mean baseline.
                  </PipelineStep>
                  <PipelineStep done={readiness.ready_to_train}>
                    <strong className="font-semibold text-ink">Reach enough distinct images.</strong>{" "}
                    Generalisation is scored by holding whole images out, so the sample size is distinct images, not epochs.
                  </PipelineStep>
                </ul>
              </Card>
            </div>
          )}
        </PageContainer>
      </main>
    </>
  );
}

function Metric({ label, value, hint }) {
  return (
    <div>
      <div className="font-mono text-[10px] font-semibold tracking-[0.12em] uppercase text-muted">{label}</div>
      <div className="mt-1 text-[19px] font-bold tracking-tight text-ink tnum">{value}</div>
      {hint && <div className="mt-0.5 text-[12px] text-muted">{hint}</div>}
    </div>
  );
}
