"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  getPhase1Status,
  getPhase1Model,
  getPhase1Sessions,
  getPhase1Predictions,
  getPhase1ClientSessions,
  trainPhase1Model,
} from "@/utils/api";
import TopNav from "@/components/TopNav";
import TimeSeriesChart from "@/components/TimeSeriesChart";
import AffectQuadrantChart from "@/components/AffectQuadrantChart";
import {
  MID,
  WEAK_CONFIDENCE,
  quadrantBreakdown,
  quadrantConfidence,
  quadrantOf,
} from "@/components/affect";
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

/* Collapsible explanation. Kept closed by default so the page stays scannable
   for people who already know the vocabulary. */
function Explainer({ title, children, defaultOpen = false }) {
  return (
    <details open={defaultOpen} className="group border-t border-border pt-4 first:border-t-0 first:pt-0">
      <summary className="flex cursor-pointer select-none list-none items-center gap-2 text-[13px] font-semibold text-accent-strong hover:text-accent">
        <span className="text-[10px] transition-transform group-open:rotate-90">▶</span>
        {title}
      </summary>
      <div className="mt-3 space-y-2.5 text-[13px] leading-relaxed text-ink-2">{children}</div>
    </details>
  );
}

/* Distribution of a session's predictions across the four quadrants. Reads as a
   single stacked bar so the dominant region is obvious without counting dots. */
function QuadrantSummary({ breakdown, weak }) {
  if (!breakdown.length) return null;
  const top = breakdown[0];
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-inset">
        {breakdown.map((q) => (
          <div
            key={q.key}
            style={{ width: `${q.pct * 100}%`, background: `var(${q.color})` }}
            title={`${q.label}: ${q.n} windows`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
        {breakdown.map((q) => (
          <span key={q.key} className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: `var(${q.color})` }}
            />
            {q.label}
            <span className="font-mono text-muted tnum">
              {Math.round(q.pct * 100)}%
            </span>
          </span>
        ))}
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
        Most of this session&apos;s predictions fall in the{" "}
        <strong className="font-semibold text-ink">{top.label}</strong> region (
        {Math.round(top.pct * 100)}% of windows).
        {weak > 0 && (
          <>
            {" "}
            <span className="text-muted">
              {weak} of {breakdown.reduce((a, q) => a + q.n, 0)} sit close enough to the
              centre that their region is effectively a coin flip.
            </span>
          </>
        )}
      </p>
    </div>
  );
}

/* Which model produced the trajectory on screen. Only rendered when a session
   genuinely has more than one — with a single model there is no choice to make and
   the control would be decoration. */
function ModelSwitch({ models, value, onChange }) {
  if (!models || models.length < 2) return null;
  return (
    <div className="inline-flex rounded-md border border-border p-0.5">
      {models.map((m) => {
        const personal = m.client_id != null;
        const active = m.model_version === value;
        return (
          <button
            key={m.model_version}
            type="button"
            onClick={() => onChange(m.model_version)}
            className={`rounded px-2.5 py-1 text-[12px] font-medium transition-colors ${
              active ? "bg-accent text-on-accent" : "text-ink-2 hover:text-ink"
            }`}
            title={`Model v${m.model_version} · ${m.n_predictions} windows`}
          >
            {personal ? "This client" : "All clients"}
          </button>
        );
      })}
    </div>
  );
}

function Term({ term, children }) {
  return (
    <p>
      <strong className="font-semibold text-ink">{term}</strong> — {children}
    </p>
  );
}

/* The 1–7 OASIS rating scale, drawn so the direction is obvious at a glance. */
function ScaleRow({ label, low, high, color }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-semibold text-ink">{label}</span>
        <span className="font-mono text-[11px] text-muted">scale 1–7</span>
      </div>
      <div
        className="mt-2 h-2 w-full rounded-full"
        style={{ background: `linear-gradient(90deg, var(--inset), var(${color}))` }}
      />
      <div className="mt-1.5 flex justify-between text-[12px] text-muted">
        <span>
          <span className="font-mono tnum">1</span> · {low}
        </span>
        <span>
          {high} · <span className="font-mono tnum">7</span>
        </span>
      </div>
    </div>
  );
}

/* Plain-English verdict on whether the model is actually doing anything useful,
   derived from the same comparison the promotion gate uses (CV R² vs the
   predict-the-mean baseline on both targets). */
function modelVerdict(m) {
  if (!m) return null;
  const pairs = [
    [m.cv_r2_valence, m.null_r2_valence],
    [m.cv_r2_arousal, m.null_r2_arousal],
  ];
  if (pairs.some(([cv]) => cv == null)) return { tone: "neutral", text: "Not enough data to score this model yet — it is serving predictions, but its accuracy is unmeasured." };
  const beaten = pairs.filter(([cv, nul]) => cv > (nul ?? -Infinity)).length;
  if (beaten === 2) return { tone: "good", text: "This model predicts better than simply guessing the average rating, on both valence and arousal." };
  if (beaten === 1) return { tone: "warn", text: "This model beats guess-the-average on one of the two measures only." };
  return { tone: "warn", text: "This model does not yet predict better than simply guessing the average rating." };
}

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
  const [primerOpen, setPrimerOpen] = useState(false);
  const [pathOpen, setPathOpen] = useState(false);
  const [trainPanelOpen, setTrainPanelOpen] = useState(false);
  const [clientSessions, setClientSessions] = useState(null);
  const [chosenSessions, setChosenSessions] = useState(new Set());
  const [training, setTraining] = useState(false);
  const [trainResult, setTrainResult] = useState(null);

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

  const loadPredictions = async (sessionId, modelVersion) => {
    setSelectedSession(sessionId);
    setPredictions(null);
    if (!sessionId) {
      setTrainPanelOpen(false);
      setTrainResult(null);
      return;
    }
    setPredLoading(true);
    try {
      const res = await getPhase1Predictions(sessionId, modelVersion);
      if (res.ok) setPredictions(await res.json());
    } catch {
      /* leave predictions null → chart shows empty state */
    } finally {
      setPredLoading(false);
    }
  };

  /* Open the training panel for the selected session's client, pre-selecting every
     one of their sessions. Pre-selecting all is the honest default: excluding a
     session should be a deliberate act with a reason, not the starting position. */
  const openTrainPanel = async () => {
    if (!selectedClient) return;
    setTrainPanelOpen(true);
    setTrainResult(null);
    setClientSessions(null);
    try {
      const res = await getPhase1ClientSessions(selectedClient.client_id);
      if (res.ok) {
        const data = await res.json();
        setClientSessions(data.session_ids || []);
        setChosenSessions(new Set(data.session_ids || []));
      }
    } catch {
      setClientSessions([]);
    }
  };

  const generateModel = async () => {
    if (!selectedClient || chosenSessions.size === 0) return;
    setTraining(true);
    setTrainResult(null);
    try {
      const res = await trainPhase1Model({
        clientId: selectedClient.client_id,
        sessionIds: [...chosenSessions],
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTrainResult({ ok: false, message: data.message || "Training failed." });
      } else {
        setTrainResult({ ok: data.trained, message: data.message, model: data.model });
        if (data.trained) {
          // Refresh the model card and re-read this session so the tab shows the
          // model that was just generated rather than the one it replaced.
          await load();
          await loadPredictions(selectedSession);
        }
      }
    } catch {
      setTrainResult({ ok: false, message: "Could not reach the server." });
    } finally {
      setTraining(false);
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
  const verdict = modelVerdict(current);

  const predRows = predictions?.predictions || [];
  const availableModels = predictions?.available_models || [];
  const shownModelVersion = predictions?.model_version ?? null;
  const shownModel = availableModels.find((m) => m.model_version === shownModelVersion) || null;
  const selectedClient = sessions.find((s) => s.session_id === selectedSession) || null;

  const predSamples = predRows.map((p) => ({
    t_seconds: Number(p.t_seconds),
    valence: p.pred_valence,
    arousal: p.pred_arousal,
    actual_valence: p.actual_valence,
    actual_arousal: p.actual_arousal,
  }));

  /* Points for the circumplex. Predictions are per 2 s window; the ground truth
     is per IMAGE, so it is deduped — otherwise one image contributes ~17
     identical diamonds and the truth cloud looks denser than it is. */
  const quadPredicted = predSamples
    .filter((p) => p.valence != null && p.arousal != null)
    .map((p) => ({ valence: p.valence, arousal: p.arousal, t_seconds: p.t_seconds }));

  const quadActual = (() => {
    const seen = new Map();
    for (const p of predRows) {
      if (p.actual_valence == null || p.actual_arousal == null) continue;
      const key = p.image_id || `${p.actual_valence}:${p.actual_arousal}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        valence: Number(p.actual_valence),
        arousal: Number(p.actual_arousal),
        label: "Established rating of one image shown",
      });
    }
    return [...seen.values()];
  })();

  const breakdown = quadrantBreakdown(quadPredicted);
  const weakCount = quadPredicted.filter(
    (p) => quadrantConfidence(p.valence, p.arousal) < WEAK_CONFIDENCE
  ).length;

  /* Names the emotion region under the predicted trajectory's tooltip, so the
     time chart and the circumplex tell the same story at the same instant. */
  const annotateEmotion = (ps) => {
    // Both panels carry a series called "Predicted" and share one axis pointer,
    // so the hover yields two of them in panel order: valence first, arousal
    // second. Order is the only thing distinguishing them.
    const [valence, arousal] = ps
      .filter((p) => p.seriesName === "Predicted")
      .map((p) => p.value?.[1]);
    const q = quadrantOf(valence, arousal);
    if (!q) return null;
    const weak = quadrantConfidence(valence, arousal) < WEAK_CONFIDENCE;
    return (
      `<div style="font-weight:600">${q.label}</div>` +
      `<div style="font-size:11px;opacity:.75;margin-top:1px">` +
      (weak ? "near the centre — region uncertain" : q.words) +
      `</div>`
    );
  };

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
              {/* Plain-language primer — this tab is read by clinicians, not ML people */}
              <Card>
                <CardHeader
                  title="What this page shows"
                  subtitle="A plain-language guide to the model and the numbers below."
                  actions={
                    <Button variant="ghost" onClick={() => setPrimerOpen((o) => !o)}>
                      {primerOpen ? "Hide" : "Show"}
                    </Button>
                  }
                />
                <div className={`px-6 py-5 ${primerOpen ? "" : "hidden"}`}>
                  <p className="text-[13.5px] leading-relaxed text-ink-2">
                    Every OASIS image used in a session comes with an{" "}
                    <strong className="font-semibold text-ink">established emotional rating</strong>,
                    averaged from hundreds of people who rated it in published research. We record
                    the client&apos;s EEG while they look at that image, and train a model to work
                    backwards: given only the brain activity, predict the rating the image is known
                    to carry. The two things it predicts are:
                  </p>

                  <div className="mt-5 grid gap-5 sm:grid-cols-2">
                    <ScaleRow
                      label="Valence — how pleasant"
                      low="unpleasant, distressing"
                      high="pleasant, positive"
                      color="--accent"
                    />
                    <ScaleRow
                      label="Arousal — how intense"
                      low="calm, relaxed"
                      high="excited, activated"
                      color="--warn"
                    />
                  </div>
                  <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
                    The two are independent: a peaceful landscape is pleasant and calm, a horror
                    image is unpleasant and intense, and a thrilling one can be pleasant
                    <em> and</em> intense.
                  </p>

                  <div className="mt-6 space-y-4">
                    <Explainer title="How the model works, step by step">
                      <ol className="ml-4 list-decimal space-y-1.5">
                        <li>
                          While an image is on screen, the headset records EEG. That stretch is cut
                          into overlapping <strong className="font-semibold text-ink">2-second
                          windows</strong> (called <em>epochs</em>) — the unit the model learns from.
                        </li>
                        <li>
                          Each window is reduced to 50 numbers summarising the brain rhythms present
                          — the strength of the delta/theta/alpha/beta/gamma bands at each electrode,
                          their ratios, and left-versus-right frontal balance (a long-established
                          correlate of pleasant versus unpleasant feeling).
                        </li>
                        <li>
                          Those numbers are re-scaled within each session, so the model can&apos;t
                          cheat by recognising <em>which recording</em> it is looking at instead of
                          learning the brain pattern.
                        </li>
                        <li>
                          A regression model (ridge regression or a random forest — deliberately
                          simple, because the dataset is small) learns the mapping from those numbers
                          to the image&apos;s known valence and arousal.
                        </li>
                        <li>
                          Afterwards, every completed session is run through the trained model
                          automatically, producing the predicted trajectory shown below. Training
                          happens separately, about once a week — new recordings do not change
                          existing predictions.
                        </li>
                      </ol>
                    </Explainer>

                    <Explainer title="What the numbers mean (and which direction is good)">
                      <Term term="R² — higher is better">
                        How much of the real variation the model captures.{" "}
                        <span className="font-mono tnum">1.00</span> is a perfect prediction,{" "}
                        <span className="font-mono tnum">0.00</span> means it does no better than
                        ignoring the EEG and always guessing the average rating, and{" "}
                        <strong className="font-semibold text-ink">a negative value means it does
                        worse than that guess</strong>. Negative scores are normal for a model
                        trained on very little data.
                      </Term>
                      <Term term="Baseline (&ldquo;null&rdquo;) — the number to beat">
                        The score you would get by always predicting the average rating, without
                        looking at the brain at all. The model is only earning its keep when its R²
                        is above this.
                      </Term>
                      <Term term="Typical error — lower is better">
                        On average, how far off the prediction is, in points on the 1–7 scale. An
                        error of <span className="font-mono tnum">0.5</span> means predictions land
                        about half a point from the true rating.
                      </Term>
                      <Term term="Distinct images — the real sample size">
                        A single image produces many 2-second windows, but they all share one correct
                        answer, so they are not independent examples. Progress toward a trustworthy
                        model is therefore counted in <em>different images recorded</em>, not hours of
                        EEG — which is why the target below is measured that way.
                      </Term>
                    </Explainer>

                    <Explainer title="How much should I trust it today?">
                      <p>
                        Treat it as a working pipeline, not a clinical measure. The full loop —
                        record, train, predict, display — is built and running, but the model has
                        seen only a small number of distinct images so far, which is far too few for
                        its predictions to be reliable about any individual person or moment. The
                        numbers on this page are there to show the system working and to track
                        progress as more sessions are recorded. Accuracy improves as OASIS-based
                        sessions accumulate.
                      </p>
                    </Explainer>
                  </div>
                </div>
              </Card>

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
                      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                        <Metric
                          label="Algorithm"
                          value={current.algo === "ridge" ? "Ridge regression" : current.algo === "random_forest" ? "Random forest" : current.algo}
                          hint="Chosen for small datasets"
                        />
                        <Metric
                          label="Learned from"
                          value={`${current.n_distinct_images ?? "—"} images`}
                          hint={`${current.n_epochs ?? "—"} two-second windows · ${current.n_sessions ?? "—"} sessions`}
                        />
                        <Metric
                          label="Trained"
                          value={current.trained_at ? new Date(current.trained_at).toLocaleDateString() : "—"}
                          hint={`Model version ${current.model_version}`}
                        />
                      </div>

                      <div className="mt-6 border-t border-border pt-5">
                        <div className="flex items-baseline justify-between gap-3">
                          <h3 className="text-[13px] font-semibold text-ink">How accurate is it?</h3>
                          <span className="text-[12px] text-muted">
                            Measured by hiding whole images from the model, then testing on them
                          </span>
                        </div>
                        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
                          <Metric
                            label="Valence R²"
                            value={fmt(current.cv_r2_valence)}
                            dir="higher"
                            hint={`vs ${fmt(current.null_r2_valence)} for guessing the average`}
                          />
                          <Metric
                            label="Arousal R²"
                            value={fmt(current.cv_r2_arousal)}
                            dir="higher"
                            hint={`vs ${fmt(current.null_r2_arousal)} for guessing the average`}
                          />
                          <Metric
                            label="Valence typical error"
                            value={fmt(current.cv_mae_valence)}
                            dir="lower"
                            hint="Points off, on the 1–7 scale"
                          />
                          <Metric
                            label="Arousal typical error"
                            value={fmt(current.cv_mae_arousal)}
                            dir="lower"
                            hint="Points off, on the 1–7 scale"
                          />
                        </div>
                        {verdict && (
                          <Alert tone={verdict.tone === "good" ? "good" : verdict.tone === "warn" ? "warn" : "accent"} className="mt-5">
                            <span className="block">{verdict.text}</span>
                            {verdict.tone !== "good" && (
                              <span className="mt-1 block font-normal">
                                This is expected at the current data volume and does not mean
                                anything is broken — the pipeline runs end to end, and accuracy
                                improves as more sessions are recorded over OASIS images.
                              </span>
                            )}
                          </Alert>
                        )}
                      </div>

                      {/* Personal model — only once a session (and so a client) is
                          chosen, because there is no "this client" without one. */}
                      {selectedClient?.client_id && (
                        <div className="mt-6 border-t border-border pt-5">
                          <div className="flex flex-wrap items-baseline justify-between gap-3">
                            <h3 className="text-[13px] font-semibold text-ink">
                              Personal model — {selectedClient.client_name || "this client"}
                            </h3>
                            {!trainPanelOpen && (
                              <Button variant="ghost" onClick={openTrainPanel}>
                                {selectedClient.has_personal_model ? "Retrain…" : "Train one…"}
                              </Button>
                            )}
                          </div>
                          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
                            {selectedClient.has_personal_model
                              ? "This client has their own model, trained only on their recordings. It is what their sessions are shown with."
                              : "This client has no model of their own yet, so their sessions are shown using the all-clients model."}{" "}
                            Brain activity differs enough between people that a model fitted to
                            one person usually reads them better than a shared one.
                          </p>

                          {trainPanelOpen && (
                            <div className="mt-4 rounded-md border border-border bg-inset/40 p-4">
                              {clientSessions === null ? (
                                <div className="flex items-center gap-2 text-muted">
                                  <Spinner size={14} />
                                  <span className="text-[13px]">Loading this client&apos;s sessions…</span>
                                </div>
                              ) : clientSessions.length === 0 ? (
                                <p className="text-[13px] text-muted">
                                  This client has no completed sessions to train from yet.
                                </p>
                              ) : (
                                <>
                                  <p className="text-[13px] font-semibold text-ink">
                                    Train on which sessions?
                                  </p>
                                  <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
                                    All are included by default. Leave a recording out only if
                                    you know it was bad — a dead electrode, say. Which sessions
                                    you chose is recorded alongside the model.
                                  </p>
                                  <div className="mt-3 max-h-44 space-y-1.5 overflow-y-auto">
                                    {clientSessions.map((sid) => {
                                      const meta = sessions.find((s) => s.session_id === sid);
                                      return (
                                        <label
                                          key={sid}
                                          className="flex cursor-pointer items-center gap-2.5 text-[13px] text-ink-2"
                                        >
                                          <input
                                            type="checkbox"
                                            className="accent-[var(--accent)]"
                                            checked={chosenSessions.has(sid)}
                                            onChange={(e) => {
                                              const next = new Set(chosenSessions);
                                              if (e.target.checked) next.add(sid);
                                              else next.delete(sid);
                                              setChosenSessions(next);
                                            }}
                                          />
                                          <span className="font-mono text-[12px]">{shortId(sid)}</span>
                                          {meta && (
                                            <span className="text-muted">
                                              {new Date(meta.start_time).toLocaleDateString()}
                                            </span>
                                          )}
                                        </label>
                                      );
                                    })}
                                  </div>
                                  <div className="mt-4 flex flex-wrap items-center gap-2">
                                    <Button
                                      onClick={generateModel}
                                      disabled={training || chosenSessions.size === 0}
                                    >
                                      {training
                                        ? "Training…"
                                        : `Train on ${chosenSessions.size} session${chosenSessions.size === 1 ? "" : "s"}`}
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      onClick={() => setTrainPanelOpen(false)}
                                      disabled={training}
                                    >
                                      Cancel
                                    </Button>
                                  </div>
                                </>
                              )}

                              {trainResult && (
                                <Alert tone={trainResult.ok ? "good" : "warn"} className="mt-4">
                                  <span className="block">{trainResult.message}</span>
                                  {trainResult.model && (
                                    <span className="mt-1 block font-normal">
                                      Learned from{" "}
                                      <strong className="font-semibold">
                                        {trainResult.model.n_distinct_images} different images
                                      </strong>{" "}
                                      across {trainResult.model.n_sessions} session
                                      {trainResult.model.n_sessions === 1 ? "" : "s"}.
                                    </span>
                                  )}
                                </Alert>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-ink-2 leading-relaxed">{readiness.message}</p>
                      <p className="mt-2 text-[13px] leading-relaxed text-muted">
                        Nothing is wrong — a model can only be trained once enough sessions have
                        been recorded over OASIS-labelled images. Progress toward that point:
                      </p>
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
                    <div className="flex flex-wrap items-center gap-2">
                      <ModelSwitch
                        models={availableModels}
                        value={shownModelVersion}
                        onChange={(v) => loadPredictions(selectedSession, v)}
                      />
                      <Select
                        className="min-w-[240px]"
                        value={selectedSession}
                        onChange={(e) => loadPredictions(e.target.value)}
                      >
                        <option value="">Select a session…</option>
                        {sessions.map((s) => (
                          <option key={s.session_id} value={s.session_id}>
                            {s.client_name ? `${s.client_name} · ` : ""}
                            {new Date(s.start_time).toLocaleDateString()} ·{" "}
                            {shortId(s.session_id)}
                            {s.n_predictions ? ` · ${s.n_predictions} pts` : " · no predictions"}
                          </option>
                        ))}
                      </Select>
                    </div>
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
                      No predictions for this session. Its recording produced no usable 2-second
                      windows — usually a dead or poorly seated electrode, or no image having been
                      shown long enough to measure.
                    </p>
                  ) : (
                    <>
                      <p className="mb-3 text-[13px] leading-relaxed text-ink-2">
                        Each point is the model&apos;s guess from one 2-second window of EEG. The
                        grey line is the image&apos;s established rating — the correct answer. The
                        closer the coloured line tracks the grey one, the better the model did here.
                        Gaps mean that stretch of EEG was unusable (a dropped Bluetooth connection
                        or a flat electrode) and was excluded rather than guessed at.
                      </p>
                      {shownModel && (
                        <p className="mb-4 text-[12.5px] leading-relaxed text-muted">
                          Shown using the{" "}
                          <strong className="font-semibold text-ink-2">
                            {shownModel.client_id ? "client's own model" : "all-clients model"}
                          </strong>{" "}
                          (v{shownModel.model_version}), which learned from{" "}
                          <strong className="font-semibold text-ink-2">
                            {shownModel.n_distinct_images ?? "—"} different images
                          </strong>
                          . That count is what limits accuracy — showing the same images again in
                          another session adds recordings, not new material to learn from.
                        </p>
                      )}
                      <TimeSeriesChart
                        samples={predSamples}
                        height={150}
                        annotate={annotateEmotion}
                        panels={[
                          { label: "Valence (pleasantness) · predicted vs actual", unit: "", min: 1, max: 7,
                            series: [
                              { key: "valence", label: "Predicted", color: "--accent" },
                              { key: "actual_valence", label: "Actual (OASIS)", color: "--muted" },
                            ] },
                          { label: "Arousal (intensity) · predicted vs actual", unit: "", min: 1, max: 7,
                            series: [
                              { key: "arousal", label: "Predicted", color: "--warn" },
                              { key: "actual_arousal", label: "Actual (OASIS)", color: "--muted" },
                            ] },
                        ]}
                      />
                    </>
                  )}
                </div>
              </Card>

              {/* Emotional map — the circumplex */}
              {trained && selectedSession && !predLoading && quadPredicted.length > 0 && (
                <Card>
                  <CardHeader
                    title="Emotional map"
                    subtitle="Where this session's predictions land on the valence–arousal plane."
                  />
                  <div className="px-6 py-5">
                    <p className="mb-1 text-[13.5px] leading-relaxed text-ink-2">
                      The same two measures as above, plotted against each other instead of
                      against time. Combining them divides the space into four regions — the
                      standard map of emotion used in psychology (Russell&apos;s circumplex).
                      Each teal dot is one 2-second window of EEG; each hollow diamond is the
                      established rating of an image that was actually shown.
                    </p>
                    <p className="mb-5 text-[12.5px] leading-relaxed text-muted">
                      The distance between the two clouds is the model&apos;s error, shown as
                      space rather than as a number. If the diamonds themselves cluster in one
                      region, the image set does not yet cover the whole plane — a model cannot
                      learn to recognise a feeling it has never been shown.
                    </p>

                    <AffectQuadrantChart predicted={quadPredicted} actual={quadActual} />

                    <div className="mt-5 border-t border-border pt-5">
                      <QuadrantSummary breakdown={breakdown} weak={weakCount} />
                    </div>

                    <Alert tone="warn" className="mt-5">
                      Region names describe an area of the chart, not a clinical finding. The
                      boundaries sit at the midpoint of each scale ({MID}.0), so a prediction of{" "}
                      {MID}.05 and one of {(MID - 0.05).toFixed(2)} are named differently while
                      being statistically indistinguishable — and at the current data volume the
                      model&apos;s predictions vary far too little for the region to describe how
                      anyone actually felt.
                    </Alert>
                  </div>
                </Card>
              )}

              {/* Data coverage */}
              <div>
                <h2 className="text-[13px] font-semibold text-ink">Training data collected</h2>
                <p className="mb-3 mt-0.5 text-[12.5px] text-muted">
                  How much material the model has to learn from. Only sessions recorded over
                  rated images can teach it anything.
                </p>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                  <StatCard label="Completed sessions" value={data.sessions_completed ?? "—"} hint="Recorded and finished" />
                  <StatCard label="Rated images available" value={data.oasis_images_labelled ?? "—"} hint="Carry a known valence & arousal" />
                  <StatCard label="Sessions using them" value={data.sessions_with_oasis_eeg ?? "—"} hint="Recorded over rated images" />
                  <StatCard label="Different images seen" value={data.distinct_labelled_images ?? "—"} hint="The number that matters most" />
                  <StatCard label="Image viewings" value={data.labelled_image_events ?? "—"} hint="Each one becomes EEG to learn from" />
                </div>
              </div>

              {/* Path to a trained model */}
              <Card>
                <CardHeader
                  title="Path to a trustworthy model"
                  subtitle="Everything runs end to end today. What is left is collecting enough data for the predictions to be reliable."
                  actions={
                    <Button variant="ghost" onClick={() => setPathOpen((o) => !o)}>
                      {pathOpen ? "Hide" : "Show"}
                    </Button>
                  }
                />
                <ul className={`space-y-3 px-6 py-5 ${pathOpen ? "" : "hidden"}`}>
                  <PipelineStep done={(data.oasis_images_labelled || 0) > 0}>
                    <strong className="font-semibold text-ink">Rated images loaded.</strong>{" "}
                    Each OASIS image carries a valence &amp; arousal rating averaged over hundreds of
                    people — these are the answers the model learns from.
                  </PipelineStep>
                  <PipelineStep done={(data.sessions_with_oasis_eeg || 0) > 0}>
                    <strong className="font-semibold text-ink">Record sessions using those images.</strong>{" "}
                    A session only becomes training data if its image set is built from rated OASIS
                    images. Sessions run on other images still work normally, they just teach the
                    model nothing.
                  </PipelineStep>
                  <PipelineStep done={trained}>
                    <strong className="font-semibold text-ink">Train a model.</strong>{" "}
                    Happens automatically each week once there is data. A retrained model only
                    replaces the one in use if it scores at least as well.
                  </PipelineStep>
                  <PipelineStep done={readiness.ready_to_train}>
                    <strong className="font-semibold text-ink">Reach enough different images.</strong>{" "}
                    Accuracy is tested by hiding whole images from the model and checking its guesses
                    on them, so what counts is the number of different images recorded — not the
                    amount of EEG. This is the step that takes time.
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

function Metric({ label, value, hint, dir }) {
  return (
    <div>
      <div className="font-mono text-[10px] font-semibold tracking-[0.12em] uppercase text-muted">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-[19px] font-bold tracking-tight text-ink tnum">{value}</span>
        {dir && (
          <span className="text-[11px] font-medium text-muted whitespace-nowrap">
            {dir === "higher" ? "↑ better" : "↓ better"}
          </span>
        )}
      </div>
      {hint && <div className="mt-0.5 text-[12px] text-muted">{hint}</div>}
    </div>
  );
}
