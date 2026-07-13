"use client";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  fetchWithAuth,
  getImages,
  getQuestions,
  getQuestionnaires,
  getQuestionnaireQuestions,
  startSession,
  getSession,
  endSession,
  createEvent,
  hideEvent,
  submitQuestionnaireAnswers,
} from "@/utils/api";
import { SessionTopBar } from "@/components/TopNav";
import { Card, Button, Label, Pill, Alert, Spinner, Field, Input } from "@/components/ui";
import LikertSurvey, { allAnswered as allSurveyAnswered } from "@/components/LikertSurvey";

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

  const [surveyQuestions, setSurveyQuestions] = useState([]);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [currentSurveyIndex, setCurrentSurveyIndex] = useState(0);
  const [surveyComplete, setSurveyComplete] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState("en");
  const [questionnaires, setQuestionnaires] = useState([]);
  const [selectedQuestionnaireId, setSelectedQuestionnaireId] = useState("");
  const [surveyAnswers, setSurveyAnswers] = useState({});
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const currentEventIdRef = useRef(null);
  const [currentMathIndex, setCurrentMathIndex] = useState(0);
  const [mathAnswers, setMathAnswers] = useState({});
  const [mathInputEnabled, setMathInputEnabled] = useState(false);
  const currentMathEventIdRef = useRef(null);
  const [patientName, setPatientName] = useState("");

  useEffect(() => {
    setPatientName(localStorage.getItem("currentClientName") || "");
  }, []);

  // 1. FETCH IMAGES ON LOAD
  useEffect(() => {
    const fetchImages = async () => {
      try {
        const res = await getImages();
        if (res.ok) {
          const data = await res.json();
          setImages(data);
        }
      } catch (err) {
        console.error("Failed to fetch images", err);
      }
    };
    fetchImages();
  }, []);

  // 2. FETCH MATH QUESTIONS
  useEffect(() => {
    if (currentStep === "math" && questions.length === 0 && !isLoadingData) {
      const fetchQuestions = async () => {
        setIsLoadingData(true);
        try {
          const res = await getQuestions();
          if (res.ok) {
            const data = await res.json();
            setQuestions(data);
            if (data.length > 0) {
              setCurrentMathIndex(0);
              setMathInputEnabled(false);
              logQuestionShown(data[0].question_id);
            }
          }
        } catch (err) {
          console.error("Failed to fetch questions", err);
        } finally {
          setIsLoadingData(false);
        }
      };
      fetchQuestions();
    }
  }, [currentStep]);

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

  // 4. FETCH SURVEY DATA (questionnaires & questions)
  useEffect(() => {
    if (currentStep === "survey" && !isLoadingData) {
      const fetchSurveyData = async () => {
        setIsLoadingData(true);
        try {
          const qRes = await getQuestionnaires();
          if (!qRes.ok) throw new Error("Failed to fetch questionnaires");
          const qData = await qRes.json();
          setQuestionnaires(qData);

          if (qData.length > 0) {
            const firstId = qData[0].questionnaire_id || qData[0].id;
            setSelectedQuestionnaireId(firstId);
            await fetchQuestionsForSurvey(firstId, selectedLanguage);
          }
        } catch (err) {
          console.error("Error loading survey:", err);
        } finally {
          setIsLoadingData(false);
        }
      };
      fetchSurveyData();
    }
  }, [currentStep]);

  const fetchQuestionsForSurvey = async (questionnaireId, language) => {
    try {
      const res = await getQuestionnaireQuestions(questionnaireId, language);
      if (res.ok) {
        const data = await res.json();
        setSurveyQuestions(data);
        setSurveyAnswers({});
      } else {
        console.error("Failed to fetch survey questions");
        setSurveyQuestions([]);
      }
    } catch (err) {
      console.error("Error fetching survey questions:", err);
    }
  };

  const handleLanguageChange = (lang) => {
    setSelectedLanguage(lang);
    if (selectedQuestionnaireId) {
      fetchQuestionsForSurvey(selectedQuestionnaireId, lang);
    }
  };

  // EVENT LOGGING HELPERS
  const logImageShown = async (imageId) => {
    if (!imageId) return;
    try {
      const sessionId = localStorage.getItem("currentSessionId");
      const res = await createEvent(sessionId, { image_id: imageId });
      if (res.ok) {
        const data = await res.json();
        currentEventIdRef.current = data.event_id || data.id;
      }
    } catch (err) { console.error("Event start failed", err); }
  };

  const logImageHidden = async () => {
    const eventId = currentEventIdRef.current;
    if (!eventId) return;
    try {
      await hideEvent(eventId);
      currentEventIdRef.current = null;
    } catch (err) { console.error("Event hide failed", err); }
  };

  const logQuestionShown = async (questionId) => {
    if (!questionId) return;
    try {
      const sessionId = localStorage.getItem("currentSessionId");
      const res = await createEvent(sessionId, { question_id: questionId });
      if (res.ok) {
        const data = await res.json();
        currentMathEventIdRef.current = data.event_id || data.id;
      }
    } catch (err) { console.error("Question event start failed", err); }
  };

  const logQuestionHidden = async () => {
    const eventId = currentMathEventIdRef.current;
    if (!eventId) return;
    try {
      await hideEvent(eventId);
      currentMathEventIdRef.current = null;
    } catch (err) { console.error("Question event hide failed", err); }
  };

  // 5. IMAGES: AUTO-ADVANCE
  useEffect(() => {
    let timer;
    if (currentStep === "images" && images.length > 0) {
      timer = setTimeout(async () => {
        await logImageHidden();
        if (currentImageIndex < images.length - 1) {
          const nextIdx = currentImageIndex + 1;
          setCurrentImageIndex(nextIdx);
          await logImageShown(images[nextIdx].image_id);
        } else {
          setCurrentStep("math");
        }
      }, 1000);
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
            setCurrentStep("images");
            if (images.length > 0) {
              await logImageShown(images[0].image_id);
            }
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
    setMathAnswers((prev) => ({ ...prev, [currentMathIndex]: value }));
  };

  const handleNextMath = async () => {
    if (!mathAnswers[currentMathIndex]?.trim()) {
      alert("Please provide an answer before proceeding.");
      return;
    }
    await logQuestionHidden();
    if (currentMathIndex < questions.length - 1) {
      const nextIdx = currentMathIndex + 1;
      setCurrentMathIndex(nextIdx);
      setMathInputEnabled(false);
      await logQuestionShown(questions[nextIdx].question_id);
    } else {
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

  // 9. SURVEY NAVIGATION
  const handleSubmitSurvey = async () => {
    if (!allSurveyAnswered(surveyQuestions, surveyAnswers)) {
      alert("Please answer all questions.");
      return;
    }

    try {
      const sessionId = localStorage.getItem("currentSessionId");
      const answers = surveyQuestions.map((q, idx) => ({
        question_id: q.question_id,
        answer_value: Number(surveyAnswers[idx]),
      }));

      const res = await submitQuestionnaireAnswers(sessionId, selectedQuestionnaireId, answers);
      if (!res.ok) {
        console.error("Failed to submit survey", await res.text());
        alert("Failed to submit survey. Please try again.");
        return;
      }

      setSurveyComplete(true);
      setCurrentStep("complete");
    } catch (err) {
      console.error("Error submitting survey:", err);
      alert("Network error. Please try again.");
    }
  };

  // ── UI RENDER FUNCTIONS ──────────────────────────────────────
  const renderReadyState = () => (
    <Card className="max-w-2xl mx-auto p-10 text-center anim-pop">
      <div className="mx-auto mb-6 grid h-16 w-16 place-items-center rounded-full bg-good-soft text-good text-3xl">✓</div>
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
            onChange={(e) => handleMathAnswerChange(e.target.value)}
            disabled={!mathInputEnabled}
          />
        </Field>
        <div className="flex justify-end mt-6">
          <Button onClick={handleNextMath} disabled={!mathInputEnabled || !answer.trim()}>
            {currentMathIndex < questions.length - 1 ? "Next question" : "Finish & end session"}
          </Button>
        </div>
      </Card>
    );
  };

  const renderSurvey = () => {
    if (isLoadingData) {
      return (
        <Card className="max-w-4xl mx-auto p-10 text-center">
          <Spinner size={20} className="mr-2 align-[-3px] text-accent" />
          <span className="text-muted">Loading survey…</span>
        </Card>
      );
    }
    if (surveyComplete) {
      return (
        <Card className="max-w-4xl mx-auto p-10 text-center">
          <h2 className="text-2xl font-bold text-ink">Survey submitted</h2>
          <p className="text-muted mt-2">Redirecting to completion…</p>
        </Card>
      );
    }
    if (surveyQuestions.length === 0) {
      return (
        <Card className="max-w-4xl mx-auto p-10 text-center">
          <p className="text-muted">No survey questions available.</p>
        </Card>
      );
    }

    const ready = allSurveyAnswered(surveyQuestions, surveyAnswers);

    return (
      <Card className="max-w-4xl mx-auto p-8">
        <div className="flex justify-between items-center mb-6 pb-4 border-b border-border">
          <h2 className="text-xl font-bold tracking-tight text-ink">Post-session survey</h2>
          <div className="flex gap-1.5">
            {["en", "ms", "zh"].map((lang) => (
              <button
                key={lang}
                onClick={() => handleLanguageChange(lang)}
                className={`px-3 py-1 text-[11px] font-bold rounded-full transition-colors ${
                  selectedLanguage === lang ? "bg-accent text-on-accent" : "bg-inset text-ink-2 hover:bg-border/60"
                }`}
              >
                {lang.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <LikertSurvey
          questions={surveyQuestions}
          answers={surveyAnswers}
          language={selectedLanguage}
          onChange={(idx, value) => setSurveyAnswers((prev) => ({ ...prev, [idx]: value }))}
        />

        <div className="flex justify-end pt-5 mt-6 border-t border-border">
          <Button onClick={handleSubmitSurvey} disabled={!ready}>
            Finish survey
          </Button>
        </div>
      </Card>
    );
  };

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
              <div className="mx-auto mb-6 grid h-16 w-16 place-items-center rounded-full bg-good-soft text-good text-3xl">✓</div>
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
