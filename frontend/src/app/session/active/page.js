"use client";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  fetchWithAuth,
  getImages,
  getClinicStimulusSet,
  getQuestions,
  startSession,
  getSession,
  endSession,
  createEvent,
  hideEvent,
} from "@/utils/api";
import { SessionTopBar } from "@/components/TopNav";
import { Card, Button, Label, Pill, Alert, Spinner, Field, Input } from "@/components/ui";
import PostSessionSurvey from "@/components/PostSessionSurvey";

// How long each stimulus image stays on screen (ms).
const IMAGE_DISPLAY_MS = 3000;

const PHASES = [
  { key: "connect", label: "Connect" },
  { key: "images", label: "Images" },
  { key: "math", label: "Math" },
  { key: "survey", label: "Survey" },
  { key: "done", label: "Done" },
];

function phaseOf(step) {
  if (step === "ready" || step === "connecting") return "connect";
  if (step === "complete") return "done";
  return step;
}

function Stepper({ step }) {
  const active = phaseOf(step);
  const activeIdx = PHASES.findIndex((p) => p.key === active);
  return (
    <div className="flex items-center justify-center gap-2 sm:gap-3 flex-wrap">
      {PHASES.map((p, i) => {
        const state = i < activeIdx ? "done" : i === activeIdx ? "active" : "todo";
        return (
          <div key={p.key} className="flex items-center gap-2 sm:gap-3">
            <div className="flex items-center gap-2">
              <span
                className={`grid place-items-center h-6 w-6 rounded-full text-[11px] font-bold tnum transition-colors ${
                  state === "done"
                    ? "bg-accent text-on-accent"
                    : state === "active"
                    ? "bg-accent-soft text-accent-strong ring-2 ring-accent/30"
                    : "bg-inset text-muted"
                }`}
              >
                {state === "done" ? "✓" : i + 1}
              </span>
              <span className={`text-[12.5px] font-semibold ${state === "todo" ? "text-muted" : "text-ink"}`}>{p.label}</span>
            </div>
            {i < PHASES.length - 1 && <span className={`h-px w-5 sm:w-8 ${i < activeIdx ? "bg-accent" : "bg-border"}`} />}
          </div>
        );
      })}
    </div>
  );
}

export default function ActiveSessionMockup() {
  const router = useRouter();

  const [currentStep, setCurrentStep] = useState("ready");
  const [isWaitingForBridge, setIsWaitingForBridge] = useState(false);
  const [pollingError, setPollingError] = useState("");

  const [images, setImages] = useState([]);
  const [questions, setQuestions] = useState([]);

  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const currentEventIdRef = useRef(null);
  const [currentMathIndex, setCurrentMathIndex] = useState(0);
  const [mathAnswers, setMathAnswers] = useState({});
  const [mathError, setMathError] = useState("");
  const [mathInputEnabled, setMathInputEnabled] = useState(false);
  const currentMathEventIdRef = useRef(null);
  const [patientName, setPatientName] = useState("");

  useEffect(() => {
    setPatientName(localStorage.getItem("currentClientName") || "");
  }, []);

  // 1. FETCH ALL STIMULI ON LOAD — images AND math questions. Both are needed
  // mid-recording, and fetching them lazily put a network round-trip (and an
  // image download) inside the stimulus timeline, leaving the participant on a
  // blank stage — visible as unmarked gaps in the recorded EEG.
  useEffect(() => {
    const fetchImages = async () => {
      try {
        const stimulusSetId = localStorage.getItem("currentStimulusSetId");
        const res = stimulusSetId
          ? await getClinicStimulusSet(stimulusSetId)
          : await getImages({ page: 1, limit: 50 });
        if (res.ok) {
          const data = await res.json();
          // A claimed session is pinned to the clinic's active set. The catalog
          // fallback keeps older sessions (which predate stimulus sets) usable.
          const sessionImages = Array.isArray(data.data?.images)
            ? data.data.images
            : Array.isArray(data.data)
            ? data.data
            : Array.isArray(data)
            ? data
            : [];
          setImages(sessionImages);
          // Warm the browser cache so every swap during the timed sequence is
          // instant instead of waiting on a fetch from object storage.
          sessionImages.forEach((img) => {
            if (img.url) {
              const pre = new window.Image();
              pre.src = img.url;
            }
          });
        }
      } catch (err) {
        console.error("Failed to fetch images", err);
      }
    };
    const fetchQuestions = async () => {
      try {
        const res = await getQuestions();
        if (res.ok) setQuestions(await res.json());
      } catch (err) {
        console.error("Failed to fetch questions", err);
      }
    };
    fetchImages();
    fetchQuestions();
  }, []);

  // 2. MATH PHASE ENTRY — questions are already prefetched; just log the first
  // one as shown. The refs guard strict-mode/effect re-runs from double-logging
  // and cap the fallback refetch (mount prefetch failed) at a single retry.
  const mathStartedRef = useRef(false);
  const mathRefetchedRef = useRef(false);
  useEffect(() => {
    if (currentStep !== "math") return;
    if (questions.length === 0) {
      if (mathRefetchedRef.current) return;
      mathRefetchedRef.current = true;
      getQuestions()
        .then(async (res) => {
          if (res.ok) setQuestions(await res.json());
        })
        .catch((err) => console.error("Failed to fetch questions", err));
      return;
    }
    if (!mathStartedRef.current) {
      mathStartedRef.current = true;
      setCurrentMathIndex(0);
      setMathInputEnabled(false);
      logQuestionShown(questions[0].question_id);
    }
  }, [currentStep, questions]);

  // 3. TIMER TO ENABLE MATH INPUT (3-5s)
  useEffect(() => {
    if (currentStep === "math" && questions.length > 0) {
      const delay = 3000 + Math.random() * 2000;
      const timer = setTimeout(() => {
        setMathInputEnabled(true);
      }, delay);
      return () => clearTimeout(timer);
    }
  }, [currentStep, currentMathIndex, questions]);

  // EVENT LOGGING HELPERS
  //
  // Mid-sequence transitions send ONE create per stimulus: the backend closes the
  // previous open event and stamps the new one in the same request, so consecutive
  // windows are contiguous by construction — a client-side hide + create pair can
  // arrive out of order under latency spikes and record overlapping windows.
  // Explicit hides are only for phase exits (last image, last question), and must
  // be AWAITED there: setHiddenAt overwrites unconditionally, so a slow hide PATCH
  // landing after the next phase's create would push hidden_at past that event's
  // shown_at. The refs hold the create-request PROMISE, not the resolved id, so a
  // hide can never miss its event just because the create response was slow.
  const logStimulusShown = (ref, payload, what) => {
    const sessionId = localStorage.getItem("currentSessionId");
    ref.current = createEvent(sessionId, payload)
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        return data.event_id || data.id || null;
      })
      .catch((err) => {
        console.error(`${what} event start failed`, err);
        return null;
      });
  };

  // Claims the pending event synchronously (no double-hide race) and hides it
  // once its id is known. Returns a promise so session teardown can await the
  // final stamp; mid-sequence callers just fire and forget.
  const logStimulusHidden = (ref, what) => {
    const pending = ref.current;
    ref.current = null;
    if (!pending) return Promise.resolve();
    return Promise.resolve(pending)
      .then((eventId) => (eventId ? hideEvent(eventId) : null))
      .catch((err) => console.error(`${what} event hide failed`, err));
  };

  const logImageShown = (imageId) => {
    if (imageId) logStimulusShown(currentEventIdRef, { image_id: imageId }, "Image");
  };
  const logImageHidden = () => logStimulusHidden(currentEventIdRef, "Image");
  const logQuestionShown = (questionId) => {
    if (questionId) logStimulusShown(currentMathEventIdRef, { question_id: questionId }, "Question");
  };
  const logQuestionHidden = () => logStimulusHidden(currentMathEventIdRef, "Question");

  // 5. IMAGES: AUTO-ADVANCE. Mid-sequence there is no hide call — the next
  // image's create closes the previous event server-side, atomically. Leaving
  // the phase, the hide must RESOLVE before the math step mounts, or it could
  // land after the first question's create and overwrite its auto-closed
  // hidden_at with a later time.
  useEffect(() => {
    let timer;
    if (currentStep === "images" && images.length > 0) {
      timer = setTimeout(async () => {
        if (currentImageIndex < images.length - 1) {
          const nextIdx = currentImageIndex + 1;
          logImageShown(images[nextIdx].image_id);
          setCurrentImageIndex(nextIdx);
        } else {
          await logImageHidden();
          setCurrentStep("math");
        }
      }, IMAGE_DISPLAY_MS);
    }
    return () => clearTimeout(timer);
  }, [currentStep, currentImageIndex, images]);

  // 6. START SESSION & POLL
  const handleStartRecording = async () => {
    setPollingError("");
    setIsWaitingForBridge(true);
    setCurrentStep("connecting");

    const sessionId = localStorage.getItem("currentSessionId");
    if (!sessionId || sessionId === "undefined") {
      setPollingError("Missing Session ID. Please pair again.");
      setIsWaitingForBridge(false);
      return;
    }

    try {
      const startRes = await startSession(sessionId);
      if (!startRes.ok) throw new Error("Failed to initialize session on the server.");

      let attempts = 0;
      const pollInterval = setInterval(async () => {
        attempts++;
        const checkRes = await getSession(sessionId);
        if (checkRes.ok) {
          const sessionData = await checkRes.json();
          if (sessionData.bridge_recording_at !== null) {
            clearInterval(pollInterval);
            setIsWaitingForBridge(false);
            if (images.length > 0) logImageShown(images[0].image_id);
            setCurrentStep("images");
            return;
          }
        }
        if (attempts >= 30) {
          clearInterval(pollInterval);
          setIsWaitingForBridge(false);
          setPollingError("headset not recording — check the bridge PC");
        }
      }, 1000);
    } catch (err) {
      setIsWaitingForBridge(false);
      setPollingError("Network error while connecting to the database.");
    }
  };

  // 7. MATH NAVIGATION
  const handleMathAnswerChange = (value) => {
    if (!mathInputEnabled) return;
    setMathError("");
    setMathAnswers((prev) => ({ ...prev, [currentMathIndex]: value }));
  };

  const handleNextMath = async () => {
    if (!mathAnswers[currentMathIndex]?.trim()) {
      setMathError("Please provide an answer before proceeding.");
      return;
    }
    setMathError("");
    if (currentMathIndex < questions.length - 1) {
      // No hide: the next question's create auto-closes this event server-side.
      const nextIdx = currentMathIndex + 1;
      logQuestionShown(questions[nextIdx].question_id);
      setCurrentMathIndex(nextIdx);
      setMathInputEnabled(false);
    } else {
      // Last stimulus: make sure its hidden_at lands before end_time is stamped.
      await logQuestionHidden();
      await endSessionAndGoToSurvey();
    }
  };

  // 8. END SESSION
  const endSessionAndGoToSurvey = async () => {
    try {
      const sessionId = localStorage.getItem("currentSessionId");
      const res = await endSession(sessionId);
      if (!res.ok) throw new Error("Failed to end session");
      setCurrentStep("survey");
    } catch (err) {
      console.error("Error ending session:", err);
      setCurrentStep("survey");
    }
  };

  // ── UI RENDER FUNCTIONS ──────────────────────────────────────
  const renderReadyState = () => (
    <Card className="max-w-2xl mx-auto p-10 text-center anim-pop">
      <div className="mx-auto mb-6 grid h-16 w-16 place-items-center rounded-full bg-good-soft text-good-strong text-3xl">✓</div>
      <h2 className="text-2xl font-bold tracking-tight text-ink mb-2">Session claimed</h2>
      <p className="text-muted mb-8">The headset is paired. Start the session to begin recording.</p>
      <Button size="lg" fullWidth onClick={handleStartRecording}>
        Start session
      </Button>
    </Card>
  );

  const renderConnecting = () => (
    <Card className="max-w-2xl mx-auto p-10 text-center anim-pop">
      <h2 className="text-2xl font-bold tracking-tight text-ink mb-6">Waiting for the headset</h2>
      {isWaitingForBridge ? (
        <div className="flex flex-col items-center gap-4">
          <Spinner size={40} className="text-accent" />
          <p className="text-accent-strong font-semibold">Confirming the bridge has started recording…</p>
        </div>
      ) : (
        pollingError && (
          <div className="flex flex-col items-center gap-5">
            <Alert tone="crit" className="uppercase tracking-wide">{pollingError}</Alert>
            <Button variant="subtle" onClick={() => setCurrentStep("ready")}>← Try again</Button>
          </div>
        )
      )}
    </Card>
  );

  const renderImageStimuli = () => {
    if (images.length === 0) {
      return (
        <Card className="max-w-4xl mx-auto p-10 text-center">
          <h2 className="text-xl font-bold text-ink mb-4">No images found in the database.</h2>
          <Button variant="subtle" onClick={() => setCurrentStep("math")}>Skip to math →</Button>
        </Card>
      );
    }

    const currentImg = images[currentImageIndex];
    const hasImage = currentImg.url && currentImg.url.trim() !== "";

    return (
      <Card className="max-w-7xl mx-auto p-4 sm:p-5 anim-fade">
        <div className="flex justify-between items-center mb-3">
          <Label>Image {currentImageIndex + 1} of {images.length}</Label>
          {currentImg.category && <Pill tone="neutral">{currentImg.category}</Pill>}
        </div>
        <div className="w-full h-[72vh] min-h-[420px] bg-inset rounded-xl flex items-center justify-center border border-border overflow-hidden">
          {hasImage ? (
            <img
              src={currentImg.url}
              alt={currentImg.filename || "Stimulus"}
              className="w-full h-full object-contain"
              onError={(e) => {
                e.target.style.display = "none";
                const fallback = document.createElement("div");
                fallback.className = "text-muted font-medium";
                fallback.textContent = "Image not available";
                e.target.parentNode.appendChild(fallback);
              }}
            />
          ) : (
            <div className="text-muted font-medium">Image not available</div>
          )}
        </div>
        <div className="mt-4 flex gap-1.5">
          {images.map((_, i) => (
            <span
              key={i}
              className={`h-1 flex-1 rounded-full ${i < currentImageIndex ? "bg-accent" : i === currentImageIndex ? "bg-accent ring-2 ring-accent/25" : "bg-border"}`}
            />
          ))}
        </div>
      </Card>
    );
  };

  const renderMathTest = () => {
    if (questions.length === 0) {
      return (
        <Card className="max-w-4xl mx-auto p-10 text-center">
          <Spinner size={20} className="mr-2 align-[-3px] text-accent" />
          <span className="text-muted">Loading questions…</span>
        </Card>
      );
    }
    const currentQ = questions[currentMathIndex];
    const answer = mathAnswers[currentMathIndex] || "";
    return (
      <Card className="max-w-4xl mx-auto p-8 anim-pop">
        <div className="flex justify-between items-center mb-6 pb-4 border-b border-border">
          <Pill tone="crit" dot live>EEG recording</Pill>
          <Label>Question {currentMathIndex + 1} of {questions.length}</Label>
        </div>
        <div className="mb-6">
          <p className="text-4xl font-bold tracking-tight text-accent tnum">{currentQ.prompt}</p>
          {currentQ.difficulty && <p className="text-sm text-muted mt-2">Difficulty: {currentQ.difficulty}</p>}
        </div>
        <Field hint={!mathInputEnabled ? "Input unlocks in a few seconds — take a moment to read the question." : undefined}>
          <Input
            type="text"
            inputMode="numeric"
            placeholder="Type your answer…"
            value={answer}
            onChange={(e) => handleMathAnswerChange(e.target.value.replace(/[^0-9.-]/g, ""))}
            disabled={!mathInputEnabled}
          />
        </Field>
        {mathError && <Alert tone="warn" className="mt-4">{mathError}</Alert>}
        <div className="flex justify-end mt-6">
          <Button onClick={handleNextMath} disabled={!mathInputEnabled || !answer.trim()}>
            {currentMathIndex < questions.length - 1 ? "Next question" : "Finish & end session"}
          </Button>
        </div>
      </Card>
    );
  };

  const renderSurvey = () => (
    <Card className="max-w-4xl mx-auto p-8">
      <PostSessionSurvey
        sessionId={localStorage.getItem("currentSessionId")}
        onSubmitted={() => setCurrentStep("complete")}
      />
    </Card>
  );

  const recording = currentStep === "images" || currentStep === "math";

  return (
    <main className="min-h-screen bg-ground flex flex-col">
      <SessionTopBar
        onBack={() => router.push("/session")}
        backLabel="Abort session"
        patient={patientName}
        right={
          recording ? (
            <Pill tone="crit" dot live>REC</Pill>
          ) : currentStep === "complete" ? (
            <Pill tone="good" dot>Complete</Pill>
          ) : (
            <Pill tone="neutral">Idle</Pill>
          )
        }
      />

      <div className="border-b border-border bg-surface/60 py-4">
        <Stepper step={currentStep} />
      </div>

      <div className="flex-1 flex items-center justify-center px-5 py-10">
        <div className="w-full">
          {currentStep === "ready" && renderReadyState()}
          {currentStep === "connecting" && renderConnecting()}
          {currentStep === "images" && renderImageStimuli()}
          {currentStep === "math" && renderMathTest()}
          {currentStep === "survey" && renderSurvey()}
          {currentStep === "complete" && (
            <div className="max-w-2xl mx-auto text-center anim-pop">
              <div className="mx-auto mb-6 grid h-16 w-16 place-items-center rounded-full bg-good-soft text-good-strong text-3xl">✓</div>
              <h2 className="text-2xl font-bold tracking-tight text-ink mb-2">Session completed &amp; saved</h2>
              <p className="text-muted mb-8">All data has been recorded to the database.</p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Button size="lg" onClick={() => router.push("/session/result")}>
                  View session results →
                </Button>
                <Button size="lg" variant="subtle" onClick={() => router.push("/history")}>
                  Return to dashboard
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
