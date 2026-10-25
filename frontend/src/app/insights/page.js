"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import {
  getPhase1Status,
  getPhase1Sessions,
  getPhase1Predictions,
  getSessionResultEvents,
} from "@/utils/api";
import { buildEventWindows } from "@/utils/events";
import TopNav from "@/components/TopNav";
import TimeSeriesChart from "@/components/TimeSeriesChart";
import AffectQuadrantChart from "@/components/AffectQuadrantChart";
import StimulusModal from "@/components/StimulusModal";
import MlGroupsPanel from "@/components/MlGroupsPanel";
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
  Field,
  Alert,
  Spinner,
  Button,
  Select,
} from "@/components/ui";

function PipelineStep({ done, children }) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
          done ? "bg-good-soft text-good-strong" : "bg-inset text-muted"
        }`}
      >
        {done ? "✓" : "•"}
      </span>
      <span className="text-[13.5px] text-ink-2 leading-relaxed">{children}</span>
    </li>
  );
}

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

/* Which group model produced the trajectory on screen: a session gets predictions
   from every group its client is in (and keeps earlier versions). Only rendered
   when there is more than one to choose from. */
function ModelSwitch({ models, value, onChange }) {
  if (!models || models.length < 2) return null;
  return (
    <div className="inline-flex rounded-md border border-border p-0.5">
      {models.map((m) => {
        const active = m.model_version === value;
        return (
          <button
            key={m.model_version}
            type="button"
            onClick={() => onChange(m.model_version)}
            className={`rounded px-2.5 py-1 text-[12px] font-medium transition-colors ${
              active ? "bg-accent text-on-accent" : "text-ink-2 hover:text-ink"
            }`}
            title={`${m.n_predictions} windows · ${m.n_clients ?? "?"} people`}
          >
            {m.group_name ?? "Group"} (v{m.model_version})
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

/* The plain-language primer and the pipeline checklist, merged into one on-demand
   dialog. */
function HowItWorksModal({ onClose, trained, readinessReady, dataOasisLabelled, dataSessionsWithOasis }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-4 sm:p-8 bg-black/50 anim-fade"
      role="dialog"
      aria-modal="true"
      aria-label="How this page works"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-border sticky top-0 bg-surface">
          <span className="font-bold text-ink">How this page works</span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:text-ink hover:bg-inset transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="px-6 py-5">
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            Every OASIS image used in a session comes with an{" "}
            <strong className="font-semibold text-ink">established emotional rating</strong>,
            averaged from hundreds of people who rated it in published research. We record the
            client&apos;s EEG while they look at that image, and train a model to work backwards:
            given only the brain activity, predict the rating the image is known to carry. The
            two things it predicts are:
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
            The two are independent: a peaceful landscape is pleasant and calm, a horror image is
            unpleasant and intense, and a thrilling one can be pleasant<em> and</em> intense.
          </p>

          <div className="mt-6 space-y-4">
            <Explainer title="How the model works, step by step" defaultOpen>
              <ol className="ml-4 list-decimal space-y-1.5">
                <li>
                  While an image is on screen, the headset records EEG. That stretch is cut into
                  overlapping <strong className="font-semibold text-ink">2-second windows</strong>{" "}
                  (called <em>epochs</em>) — the unit the model learns from.
                </li>
                <li>
                  Each window is reduced to 50 numbers summarising the brain rhythms present — the
                  strength of the delta/theta/alpha/beta/gamma bands at each electrode, their
                  ratios, and left-versus-right frontal balance (a long-established correlate of
                  pleasant versus unpleasant feeling).
                </li>
                <li>
                  Those numbers are re-scaled within each session, so the model can&apos;t cheat
                  by recognising <em>which recording</em> it is looking at instead of learning the
                  brain pattern.
                </li>
                <li>
                  You put clients into a named <strong className="font-semibold text-ink">group</strong>.
                  Training takes each member&apos;s latest session with rated images and adds their
                  five BFI-2 personality scores to every window, then a random forest (a
                  deliberately simple model, because the dataset is small) learns the mapping to the
                  image&apos;s known valence and arousal.
                </li>
                <li>
                  Every session of every member is then run through the group&apos;s model to produce
                  the predicted trajectory shown on the page. A client can be in several groups; pick
                  which group&apos;s model to view. Training happens only when you start it — new
                  recordings get predictions from existing group models automatically, but a model
                  only learns from them when it is retrained.
                </li>
              </ol>
            </Explainer>

            <Explainer title="What the numbers mean (and which direction is good)">
              <Term term="Accuracy score — higher is better">
                Shown on the page as &ldquo;Valence accuracy&rdquo; / &ldquo;Arousal accuracy&rdquo;
                (also called R² if you&apos;ve heard that term).{" "}
                <span className="font-mono tnum">1.00</span> would be a perfect prediction,{" "}
                <span className="font-mono tnum">0.00</span> means it does no better than ignoring
                the EEG and always guessing the average rating, and{" "}
                <strong className="font-semibold text-ink">a negative number means it does worse
                than that guess</strong>. Negative scores are normal for a model trained on very
                little data — they&apos;re not a bug.
              </Term>
              <Term term="Baseline — the number to beat">
                The score you&apos;d get by always predicting the average rating, without looking at
                the brain activity at all. The model is only doing something useful once its
                accuracy score is above this.
              </Term>
              <Term term="Typical error — lower is better">
                On average, how far off the prediction is, in points on the 1–7 scale. An error of{" "}
                <span className="font-mono tnum">0.5</span> means predictions land about half a
                point from the true rating.
              </Term>
              <Term term="Distinct images — the real sample size">
                A single image produces many 2-second windows, but they all share one correct
                answer, so they are not independent examples. Progress toward a trustworthy model
                is therefore counted in <em>different images recorded</em>, not hours of EEG.
              </Term>
            </Explainer>

            <Explainer title="How much should I trust it today?">
              <p>
                Treat it as a working pipeline, not a clinical measure. The full loop — record,
                train, predict, display — is built and running, but the model has seen only a
                small number of distinct images so far, which is far too few for its predictions
                to be reliable about any individual person or moment. The numbers on this page are
                there to show the system working and to track progress as more sessions are
                recorded. Accuracy improves as OASIS-based sessions accumulate.
              </p>
            </Explainer>

            <Explainer title="Path to a trustworthy model">
              <ul className="space-y-3">
                <PipelineStep done={(dataOasisLabelled || 0) > 0}>
                  <strong className="font-semibold text-ink">Rated images loaded.</strong> Each
                  OASIS image carries a valence &amp; arousal rating averaged over hundreds of
                  people — these are the answers the model learns from.
                </PipelineStep>
                <PipelineStep done={(dataSessionsWithOasis || 0) > 0}>
                  <strong className="font-semibold text-ink">Record sessions using those
                  images.</strong> A session only becomes training data if its image set is built
                  from rated OASIS images. Sessions run on other images still work normally, they
                  just teach the model nothing.
                </PipelineStep>
                <PipelineStep done={trained}>
                  <strong className="font-semibold text-ink">Train a group model.</strong> Create a
                  group, add clients who each have a session over rated images and a completed
                  BFI-2, and train it. Accuracy is tested on one person at a time, on images the
                  model never saw. A retrained model replaces the one in use for that group.
                </PipelineStep>
                <PipelineStep done={readinessReady}>
                  <strong className="font-semibold text-ink">Reach enough different images.</strong>{" "}
                  Accuracy is tested by hiding whole images from the model and checking its
                  guesses on them, so what counts is the number of different images recorded — not
                  the amount of EEG. This is the step that takes time.
                </PipelineStep>
              </ul>
            </Explainer>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function InsightsPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const [status, setStatus] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedSession, setSelectedSession] = useState("");
  const [predictions, setPredictions] = useState(null);
  const [predLoading, setPredLoading] = useState(false);
  const [sessionEvents, setSessionEvents] = useState([]);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [sRes, seRes] = await Promise.all([
        getPhase1Status(),
        getPhase1Sessions(),
      ]);
      if (sRes.ok) setStatus(await sRes.json());
      else setError("Could not reach the ML service. It may still be starting up.");
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

  /* Predictions AND the image/question markers for the same session, so the
     valence/arousal chart can show what was actually on screen at each point. */
  const loadPredictions = async (sessionId, modelVersion) => {
    setSelectedSession(sessionId);
    setPredictions(null);
    setSessionEvents([]);
    setSelectedEvent(null);
    if (!sessionId) return;
    setPredLoading(true);
    try {
      const [predRes, evRes] = await Promise.all([
        getPhase1Predictions(sessionId, modelVersion),
        getSessionResultEvents(sessionId).catch(() => null),
      ]);
      if (predRes.ok) setPredictions(await predRes.json());
      if (evRes?.ok) {
        const evData = await evRes.json();
        const meta = sessions.find((s) => s.session_id === sessionId);
        if (meta?.start_time && Array.isArray(evData)) {
          setSessionEvents(buildEventWindows(evData, meta.start_time, Infinity));
        }
      }
    } catch {
      /* leave predictions null → chart shows empty state */
    } finally {
      setPredLoading(false);
    }
  };

  /* Client picked from the dropdown. Resets everything downstream of it. */
  const selectClient = (clientId) => {
    setSelectedClientId(clientId);
    setSelectedSession("");
    setPredictions(null);
    setSessionEvents([]);
    setSelectedEvent(null);
  };

  /* A group model was trained or deleted: refresh which clients are covered and the
     trajectory on screen, which may now come from a different model. */
  const onGroupsChanged = async () => {
    await load();
    if (selectedSession) await loadPredictions(selectedSession);
  };

  useEffect(() => {
    if (isAuthLoading) return;
    if (!isAuthenticated) {
      router.push("/login");
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, isAuthLoading, router]);

  const data = status?.data || {};
  const readiness = status?.readiness || {};

  const predRows = predictions?.predictions || [];
  const availableModels = predictions?.available_models || [];
  const shownModelVersion = predictions?.model_version ?? null;
  const shownModel = availableModels.find((m) => m.model_version === shownModelVersion) || null;

  /* Clients worth picking from, derived from the flat session list. Ordered by
     their most recent session so the people seen most recently float to the top. */
  const clients = (() => {
    const byId = new Map();
    for (const s of sessions) {
      if (!s.client_id) continue;
      const existing = byId.get(s.client_id);
      if (!existing || new Date(s.start_time) > new Date(existing.last_session_at)) {
        byId.set(s.client_id, {
          client_id: s.client_id,
          client_name: s.client_name,
          n_group_models: s.n_group_models || 0,
          last_session_at: s.start_time,
        });
      }
    }
    return [...byId.values()].sort(
      (a, b) => new Date(b.last_session_at) - new Date(a.last_session_at)
    );
  })();
  const selectedClient = clients.find((c) => c.client_id === selectedClientId) || null;
  const clientSessionOptions = sessions.filter((s) => s.client_id === selectedClientId);

  const predSamples = predRows.map((p) => ({
    t_seconds: Number(p.t_seconds),
    valence: p.pred_valence,
    arousal: p.pred_arousal,
    actual_valence: p.actual_valence,
    actual_arousal: p.actual_arousal,
  }));

  /* Points for the circumplex. Predictions are per 2 s window; the ground truth
     is per IMAGE, so it is deduped. */
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

  /* Names the emotion region under the predicted trajectory's tooltip. */
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
              <>
                <Button variant="ghost" onClick={() => setHowItWorksOpen(true)}>
                  How it works?
                </Button>
                <Button variant="ghost" onClick={load} disabled={loading}>
                  {loading ? "Refreshing…" : "Refresh"}
                </Button>
              </>
            }
          />

          {howItWorksOpen && (
            <HowItWorksModal
              onClose={() => setHowItWorksOpen(false)}
              trained={sessions.some((s) => s.n_group_models > 0)}
              readinessReady={readiness.ready_to_train}
              dataOasisLabelled={data.oasis_images_labelled}
              dataSessionsWithOasis={data.sessions_with_oasis_eeg}
            />
          )}

          {loading && !status ? (
            <div className="mt-10 flex items-center gap-3 text-muted">
              <Spinner size={18} />
              <span className="text-sm">Loading…</span>
            </div>
          ) : error ? (
            <Alert tone="crit" className="mt-6">{error}</Alert>
          ) : (
            <div className="mt-6 space-y-6">
              <MlGroupsPanel onTrained={onGroupsChanged} />

              {/* Session predictions: pick a client, then one of their sessions, then
                  (if they are in several trained groups) which group's model to view. */}
              <Card>
                <CardHeader
                  title="Session predictions"
                  subtitle="Predicted emotional trajectory across a recorded session."
                />
                <div className="px-6 py-5">
                  <Field label="Client" className="max-w-sm">
                    <Select value={selectedClientId} onChange={(e) => selectClient(e.target.value)}>
                      <option value="">Select a client…</option>
                      {clients.map((c) => (
                        <option key={c.client_id} value={c.client_id}>
                          {c.client_name || "Unnamed client"}
                          {c.n_group_models
                            ? ` · in ${c.n_group_models} trained group${c.n_group_models === 1 ? "" : "s"}`
                            : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  {selectedClientId && (
                    <div className="mt-6 border-t border-border pt-5">
                      <div className="flex flex-wrap items-end gap-4">
                        <Field label="Session" className="max-w-sm flex-1">
                          <Select
                            value={selectedSession}
                            onChange={(e) => loadPredictions(e.target.value)}
                          >
                            <option value="">Select a session…</option>
                            {clientSessionOptions.map((s) => (
                              <option key={s.session_id} value={s.session_id}>
                                {new Date(s.start_time).toLocaleDateString()} ·{" "}
                                {shortId(s.session_id)}
                                {s.n_predictions ? ` · ${s.n_predictions} pts` : " · no predictions"}
                              </option>
                            ))}
                          </Select>
                        </Field>

                        {availableModels.length > 1 && (
                          <div className="flex items-center gap-2 pb-3">
                            <span className="text-[12.5px] text-muted whitespace-nowrap">
                              Currently comparing to
                            </span>
                            <ModelSwitch
                              models={availableModels}
                              value={shownModelVersion}
                              onChange={(v) => loadPredictions(selectedSession, v)}
                            />
                          </div>
                        )}
                      </div>

                      <div className="mt-5">
                        {!selectedClient?.n_group_models ? (
                          <p className="text-sm text-muted">
                            This client is not in a trained group yet. Add them to a group above and
                            train it to generate predictions.
                          </p>
                        ) : !selectedSession ? (
                          <p className="text-sm text-muted">Pick a session to see its predicted valence & arousal over time.</p>
                        ) : predLoading ? (
                          <div className="flex items-center gap-3 text-muted">
                            <Spinner size={16} /><span className="text-sm">Loading predictions…</span>
                          </div>
                        ) : predSamples.length === 0 ? (
                          <p className="text-sm text-muted">
                            No predictions for this session. Its recording produced no usable 2-second
                            windows over rated images — usually a dead or poorly seated electrode, no
                            rated image shown long enough to measure, or no completed BFI-2 for this
                            client.
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
                                Showing predictions from the{" "}
                                <strong className="font-semibold text-ink-2">
                                  {shownModel.group_name ?? "group"} model
                                </strong>{" "}
                                (v{shownModel.model_version}, {shownModel.n_clients ?? "?"} people), built
                                on an evidence base of{" "}
                                <strong className="font-semibold text-ink-2">
                                  {shownModel.n_distinct_images ?? "—"} distinct ratings
                                </strong>
                                . That sample size is what limits accuracy — showing the same images
                                again in another session adds recordings, not new material to learn from.
                              </p>
                            )}
                            <TimeSeriesChart
                              samples={predSamples}
                              height={150}
                              annotate={annotateEmotion}
                              linkPanels
                              perPanelEventLabels
                              events={sessionEvents}
                              onEventClick={setSelectedEvent}
                              panels={[
                                { label: "Valence", title: "Valence (pleasantness) · predicted vs actual", unit: "", min: 1, max: 7,
                                  series: [
                                    { key: "valence", label: "Predicted", color: "--accent" },
                                    { key: "actual_valence", label: "Actual (established rating)", color: "--muted" },
                                  ] },
                                { label: "Arousal", title: "Arousal (intensity) · predicted vs actual", unit: "", min: 1, max: 7,
                                  series: [
                                    { key: "arousal", label: "Predicted", color: "--warn" },
                                    { key: "actual_arousal", label: "Actual (established rating)", color: "--muted" },
                                  ] },
                              ]}
                            />
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </Card>

              {/* Emotional map — the circumplex */}
              {selectedSession && !predLoading && quadPredicted.length > 0 && (
                <Card>
                  <CardHeader
                    title="Emotional map"
                    subtitle="Where this session's predictions land on the valence–arousal plane."
                  />
                  <div className="px-6 py-5">
                    <p className="mb-1 text-[13.5px] leading-relaxed text-ink-2">
                      The same two measures as above (valence and arousal), plotted against each
                      other instead of against time. That splits the space into four named regions
                      — a well-known way psychologists map emotions onto pleasantness and energy.
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
                      boundaries sit right at the middle of each scale ({MID}.0), so two
                      predictions that are barely different from each other — say {MID}.05 and{" "}
                      {(MID - 0.05).toFixed(2)} — can still land in different, differently-named
                      regions. At the current data volume, the model&apos;s predictions don&apos;t
                      vary enough for the region name to say anything reliable about how anyone
                      actually felt.
                    </Alert>
                  </div>
                </Card>
              )}
            </div>
          )}
        </PageContainer>
      </main>

      {selectedEvent != null && sessionEvents[selectedEvent] && (
        <StimulusModal event={sessionEvents[selectedEvent]} onClose={() => setSelectedEvent(null)} />
      )}
    </>
  );
}
