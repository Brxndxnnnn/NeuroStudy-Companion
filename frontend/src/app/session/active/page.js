"use client";
import { useState, useEffect, useRef, useLayoutEffect } from "react";
import { useRouter } from "next/navigation";
import {
  fetchWithAuth,
  getImages,
  getClinicStimulusSet,
  getQuestions,
  getSession,
  endSession,
  createEvent,
  hideEvent,
} from "@/utils/api";
import { calibrateSessionClock, getSessionTimestamp, resetSessionClock } from "@/utils/sessionClock";
import { SessionTopBar } from "@/components/TopNav";
import { Card, Button, Label, Pill, Alert, Spinner, Field, Input } from "@/components/ui";
import PostSessionSurvey from "@/components/PostSessionSurvey";

// Fallback for legacy sessions and before the session snapshot is loaded. The
// historical 10-second rationale below explains the default; it is not an
// enforced duration for newly paired sessions.
//
// 10 s is the REAL protocol timing, not 3 s. A training epoch is 2 s, so a 3 s
// image left only 1 s of slack and yielded at most 3 epochs — and the headset
// stalls for ~3.2 s at a time (11 such gaps in the 24 Jul session), so a single
// stall wiped out an entire image. At 10 s one stall can never kill an image:
// the 6.8 s that remain split into at most two runs, so one is always >= 3.4 s.
const DEFAULT_IMAGE_DISPLAY_MS = 10000;

// The 13-step standardised protocol (client requirement #3): a countdown + two baseline
// periods (eyes closed, then eyes open) flank the existing images -> math block on both
// sides. Each entry drives the generic phase effect below (§4) — countdown_images and
// baseline2_open are the two seams into/out of the pre-existing images/math steps.
const PROTOCOL = [
  { key: "countdown_pre", kind: "countdown", seconds: 5, next: "baseline1_closed" },
  { key: "baseline1_closed", kind: "baseline", seconds: 60, eyesClosed: true, next: "countdown_b1" },
  { key: "countdown_b1", kind: "countdown", seconds: 3, next: "baseline1_open" },
  { key: "baseline1_open", kind: "baseline", seconds: 60, eyesClosed: false, next: "countdown_images" },
  { key: "countdown_images", kind: "countdown", seconds: 5, next: "images" },
  { key: "countdown_post", kind: "countdown", seconds: 5, next: "baseline2_closed" },
  { key: "baseline2_closed", kind: "baseline", seconds: 60, eyesClosed: true, next: "countdown_b2" },
  { key: "countdown_b2", kind: "countdown", seconds: 3, next: "baseline2_open" },
  // No countdown after this one — recording stops here and the session ends (client spec).
  { key: "baseline2_open", kind: "baseline", seconds: 60, eyesClosed: false, next: "survey" },
];
const PROTOCOL_BY_KEY = Object.fromEntries(PROTOCOL.map((p) => [p.key, p]));

const PRE_IMAGE_PHASES = ["countdown_pre", "baseline1_closed", "countdown_b1", "baseline1_open", "countdown_images"];
const POST_MATH_PHASES = ["countdown_post", "baseline2_closed", "countdown_b2", "baseline2_open"];

const PHASES = [
  { key: "connect", label: "Connect" },
  { key: "baseline1", label: "Baseline 1" },
  { key: "images", label: "Images" },
  { key: "math", label: "Math" },
  { key: "baseline2", label: "Baseline 2" },
  { key: "survey", label: "Survey" },
  { key: "done", label: "Done" },
];

function phaseOf(step) {
  if (step === "awaiting") return "connect";
  if (PRE_IMAGE_PHASES.includes(step)) return "baseline1";
  if (POST_MATH_PHASES.includes(step)) return "baseline2";
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
                className={`grid place-items-center h-6 w-6 rounded-full text-[11px] font-bold tnum transition-colors ${state === "done"
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

  // The bridge now owns recording-start (client requirement #8): there is no button here,
  // only a passive wait for the technician to press Start on the bridge — see the auto-poll
  // effect below. "awaiting" replaces the old "ready"/"connecting" pair.
  const [currentStep, setCurrentStep] = useState("awaiting");
  const [pollingError, setPollingError] = useState("");

  const [images, setImages] = useState([]);
  const [questions, setQuestions] = useState([]);

  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [imageDisplayMs, setImageDisplayMs] = useState(DEFAULT_IMAGE_DISPLAY_MS);
  const currentEventIdRef = useRef(null);
  const [currentMathIndex, setCurrentMathIndex] = useState(0);
  const [mathAnswers, setMathAnswers] = useState({});
  const [mathError, setMathError] = useState("");
  const [mathInputEnabled, setMathInputEnabled] = useState(false);
  const currentMathEventIdRef = useRef(null);
  const [patientName, setPatientName] = useState("");
  const [secondsLeft, setSecondsLeft] = useState(0);
  const currentPhaseEventIdRef = useRef(null);

  // EVENT LOGGING HELPERS
  //
  // Mid-sequence transitions send ONE create per stimulus: the backend closes the
  // previous open event and stamps the new one in the same request, so consecutive
  // windows are contiguous by construction — a client-side hide + create pair can
  // arrive out of order under latency spikes and record overlapping windows.
  // Explicit hides are only for phase exits (last image, last question). The refs
  // hold the create-request PROMISE, not the resolved id, so a hide can never miss
  // its event just because the create response was slow.
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
  const logStimulusHidden = (ref, what, occurredAt) => {
    const pending = ref.current;
    ref.current = null;
    if (!pending) return Promise.resolve();
    return Promise.resolve(pending)
      .then(async (eventId) => {
        if (!eventId) return null;
        const response = await hideEvent(eventId, occurredAt);
        if (!response.ok) throw new Error(await response.text());
        return response;
      })
      .catch((err) => console.error(`${what} event hide failed`, err));
  };

  const logImageShown = (imageId, occurredAt) => {
    // if (imageId) logStimulusShown(currentEventIdRef, { image_id: imageId }, "Image");
    if (!imageId) return;
    logStimulusShown(currentEventIdRef, { image_id: imageId, occurred_at: occurredAt }, "Image");
  };
  const logImageHidden = occurredAt => logStimulusHidden(currentEventIdRef, "Image", occurredAt);
  const logQuestionShown = (questionId, occurredAt) => {
    // if (questionId) logStimulusShown(currentMathEventIdRef, { question_id: questionId }, "Question");
    if (!questionId) return;
    logStimulusShown(currentMathEventIdRef, { question_id: questionId, occurred_at: occurredAt }, "Question");
  };
  const logQuestionHidden = occurredAt => logStimulusHidden(currentMathEventIdRef, "Question", occurredAt);
  const logPhaseShown = (phase, occurredAt) => {
    logStimulusShown(currentPhaseEventIdRef, { phase, occurred_at: occurredAt }, "Phase");
  };
  const logPhaseHidden = occurredAt => logStimulusHidden(currentPhaseEventIdRef, "Phase", occurredAt);

  // Ends the session and hands off to the survey step. Declared up here (not down by the
  // math-navigation handler that historically called it) because the protocol-phase effect
  // below also calls it from inside a useEffect, which forward-referencing a later `const`
  // is not allowed to do.
  const endSessionAndGoToSurvey = async (hideRequest = Promise.resolve()) => {
    try {
      await hideRequest;
      const sessionId = localStorage.getItem("currentSessionId");
      const res = await endSession(sessionId);
      if (!res.ok) throw new Error("Failed to end session");
    } catch (err) {
      console.error("Error ending session:", err);
    }
  };

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
  const lastLoggedImageRef = useRef(null)
  const lastLoggedQuestionRef = useRef(null)
  const imagePresentationRef = useRef(null)
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
      // logQuestionShown(questions[0].question_id);
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

  // 5. IMAGES: AUTO-ADVANCE. Mid-sequence there is no hide call — the next
  // image's create closes the previous event server-side, atomically. Leaving
  // the phase, the hide must RESOLVE before the math step mounts, or it could
  // land after the first question's create and overwrite its auto-closed
  // hidden_at with a later time.
  useEffect(() => {
    if (currentStep !== "images" || images.length === 0) return;

    let frameId;
    const image = images[currentImageIndex];
    const key = image?.image_id ? `${currentImageIndex}:${image.image_id}` : null;
    const advance = (frameTime) => {
      const presentation = imagePresentationRef.current;
      if (!key || presentation?.key !== key) {
        frameId = requestAnimationFrame(advance);
        return;
      }
      if (frameTime - presentation.frameTime < imageDisplayMs) {
        frameId = requestAnimationFrame(advance);
        return;
      }

      const occurredAt = getSessionTimestamp(frameTime);
      if (currentImageIndex < images.length - 1) {
        setCurrentImageIndex((index) => index + 1);
      } else {
        logImageHidden(occurredAt);
        setCurrentStep("math");
      }
    };

    frameId = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frameId);
  }, [currentStep, currentImageIndex, images, imageDisplayMs]);

  useLayoutEffect(() => {
    if (currentStep !== 'images')
      return

    const image = images[currentImageIndex]

    if (!image?.image_id)
      return

    const key = `${currentImageIndex}:${image.image_id}`

    if (lastLoggedImageRef.current === key)
      return

    const frameId = requestAnimationFrame((frameTime) => {
      if (lastLoggedImageRef.current === key) return;
      lastLoggedImageRef.current = key;
      imagePresentationRef.current = { key, frameTime };
      logImageShown(image.image_id, getSessionTimestamp(frameTime));
    });

    return () => cancelAnimationFrame(frameId);
  }, [
    currentStep,
    currentImageIndex,
    images
  ])
  useLayoutEffect(() => {
    if (currentStep !== 'math')
      return

    const question = questions[currentMathIndex]

    if (!question?.question_id)
      return

    const key = `${currentMathIndex}:${question.question_id}`

    if (lastLoggedQuestionRef.current === key)
      return

    const frameId = requestAnimationFrame((frameTime) => {
      if (lastLoggedQuestionRef.current === key) return;
      lastLoggedQuestionRef.current = key;
      logQuestionShown(question.question_id, getSessionTimestamp(frameTime));
    });

    return () => cancelAnimationFrame(frameId);
  }, [
    currentStep,
    currentMathIndex,
    questions
  ])

  // 5b. PROTOCOL PHASES (countdowns + baseline periods): one generic auto-advance effect
  // for all nine, same requestAnimationFrame-based precision as the image auto-advance
  // above — avoids setInterval drift and ties the phase boundary to the real session-clock
  // timestamp. baseline2_open is the one phase whose "next" is "survey": that's where
  // recording actually stops, so its hide is awaited before ending the session, exactly
  // like the old last-question -> end transition used to be.
  const phasePresentationRef = useRef(null);
  const lastLoggedPhaseRef = useRef(null);
  useEffect(() => {
    const phase = PROTOCOL_BY_KEY[currentStep];
    if (!phase) return;

    let frameId;
    const durationMs = phase.seconds * 1000;
    const advance = async (frameTime) => {
      const presentation = phasePresentationRef.current;
      if (!presentation || presentation.key !== phase.key) {
        frameId = requestAnimationFrame(advance);
        return;
      }
      const elapsed = frameTime - presentation.frameTime;
      setSecondsLeft(Math.max(0, Math.ceil((durationMs - elapsed) / 1000)));
      if (elapsed < durationMs) {
        frameId = requestAnimationFrame(advance);
        return;
      }

      const occurredAt = getSessionTimestamp(frameTime);
      if (phase.next === "survey") {
        const hideRequest = logPhaseHidden(occurredAt);
        setCurrentStep("survey");
        await endSessionAndGoToSurvey(hideRequest);
      } else {
        logPhaseHidden(occurredAt);
        setCurrentStep(phase.next);
      }
    };

    frameId = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frameId);
  }, [currentStep]);

  useLayoutEffect(() => {
    const phase = PROTOCOL_BY_KEY[currentStep];
    if (!phase) return;
    if (lastLoggedPhaseRef.current === phase.key) return;

    const frameId = requestAnimationFrame((frameTime) => {
      if (lastLoggedPhaseRef.current === phase.key) return;
      lastLoggedPhaseRef.current = phase.key;
      phasePresentationRef.current = { key: phase.key, frameTime };
      logPhaseShown(phase.key, getSessionTimestamp(frameTime));
    });

    return () => cancelAnimationFrame(frameId);
  }, [currentStep]);

  // 6. AWAIT THE BRIDGE — the technician presses Start on the bridge itself, which writes
  // sync_status='recording' + bridge_recording_at directly (see NeuuroBridge.Core.DbUploader
  // .MarkRecording / .MarkRecordingStarted). This page has no start action of its own: it just
  // calibrates the clock up front and polls until the bridge confirms it's actually recording.
  // Unlike the old website-triggered flow, there is no timeout here — how long the technician
  // takes to fit the headset and press Start is entirely up to them, not an error condition.
  useEffect(() => {
    const sessionId = localStorage.getItem("currentSessionId");
    if (!sessionId || sessionId === "undefined") {
      setPollingError("Missing Session ID. Please pair again.");
      return;
    }

    resetSessionClock();
    calibrateSessionClock()
      .then((calibration) => console.info('Session clock calibrated', calibration))
      .catch((error) => console.warn('Session clock calibration failed; browser time will be used', error));

    let cancelled = false;
    const pollInterval = setInterval(async () => {
      if (cancelled) return;
      const checkRes = await getSession(sessionId);
      if (checkRes.ok) {
        const sessionData = await checkRes.json();
        if (sessionData.bridge_recording_at !== null) {
          const intervalSeconds = Number(sessionData.image_display_interval_seconds);
          if (Number.isInteger(intervalSeconds) && intervalSeconds >= 1 && intervalSeconds <= 60)
            setImageDisplayMs(intervalSeconds * 1000);
          clearInterval(pollInterval);
          setCurrentStep("countdown_pre");
        }
      }
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
    };
  }, []);

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
      // const nextIdx = currentMathIndex + 1;
      // logQuestionShown(questions[nextIdx].question_id);
      // setCurrentMathIndex(nextIdx);
      setCurrentMathIndex(currentMathIndex + 1)
      setMathInputEnabled(false);
    } else {
      // Last question: math finishing does NOT end the session anymore — the protocol's
      // second baseline block (countdown_post -> ... -> baseline2_open) still has to run
      // first. No hide-and-await here: countdown_post's create auto-closes this event
      // server-side, same as every other mid-sequence transition.
      const occurredAt = getSessionTimestamp();
      logQuestionHidden(occurredAt);
      setCurrentStep("countdown_post");
    }
  };

  // ── UI RENDER FUNCTIONS ──────────────────────────────────────
  const renderAwaitingTechnician = () => (
    <Card className="max-w-2xl mx-auto p-10 text-center anim-pop">
      {pollingError ? (
        <Alert tone="crit" className="uppercase tracking-wide">{pollingError}</Alert>
      ) : (
        <div className="flex flex-col items-center gap-4">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-good-soft text-good-strong text-3xl">✓</div>
          <h2 className="text-2xl font-bold tracking-tight text-ink mb-2">Session claimed</h2>
          <p className="text-muted">Awaiting technician to start the session on the bridge.</p>
          <Spinner size={40} className="text-accent mt-2"/>
        </div>
      )}
    </Card>
  );

  const renderCountdown = (phase) => (
    <Card className="max-w-2xl mx-auto p-10 text-center anim-pop">
      <Pill tone="crit" dot live className="mb-6">EEG recording</Pill>
      <p className="text-muted mb-4">Get ready</p>
      <div className="text-7xl font-bold tracking-tight text-accent tnum">{secondsLeft}</div>
    </Card>
  );

  const renderBaseline = (phase) => (
    <Card className="max-w-2xl mx-auto p-10 text-center anim-pop">
      <Pill tone="crit" dot live className="mb-6">EEG recording</Pill>
      <h2 className="text-2xl font-bold tracking-tight text-ink mb-2">
        {phase.eyesClosed ? "Close your eyes" : "Open your eyes"}
      </h2>
      <p className="text-muted mb-6">
        {phase.eyesClosed
          ? "Relax and keep your eyes closed until this screen changes."
          : "Keep your eyes open and look at the screen."}
      </p>
      <div className="text-5xl font-bold tracking-tight text-accent tnum">{secondsLeft}s</div>
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

  const activePhase = PROTOCOL_BY_KEY[currentStep];
  const recording = currentStep === "images" || currentStep === "math" || !!activePhase;

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
          {currentStep === "awaiting" && renderAwaitingTechnician()}
          {activePhase && (activePhase.kind === "countdown" ? renderCountdown(activePhase) : renderBaseline(activePhase))}
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
