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
          // First, get all questionnaires
          const qRes = await getQuestionnaires();
          // Get questions for a specific questionnaire
          if (!qRes.ok) throw new Error("Failed to fetch questionnaires");
          const qData = await qRes.json();
          setQuestionnaires(qData);


          if (qData.length > 0) {
            const firstId = qData[0].questionnaire_id || qData[0].id;
            setSelectedQuestionnaireId(firstId);
            // Now fetch questions for that questionnaire with the default language
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

  // Helper to fetch questions for a specific questionnaire & language
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

  // Language change handler – refetch survey questions
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



  // 5. IMAGES: AUTO-ADVANCE EVERY 10 SECONDS
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
    setMathAnswers(prev => ({
      ...prev,
      [currentMathIndex]: value
    }));
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
    // Check all answered
    const allAnswered = surveyQuestions.every(
      (_, idx) => surveyAnswers[idx] && surveyAnswers[idx].trim() !== ""
    );
    if (!allAnswered) {
      alert("Please answer all questions.");
      return;
    }

    try {
      const sessionId = localStorage.getItem("currentSessionId");
      // Build answers array
      const answers = surveyQuestions.map((q, idx) => ({
        question_id: q.question_id,
        answer_value: parseInt(surveyAnswers[idx], 10) || 0, // numeric answer
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



  // UI RENDER FUNCTIONS
  const renderReadyState = () => (
    <div className="bg-white p-12 rounded-xl shadow-md border border-slate-200 max-w-2xl mx-auto text-center animate-in fade-in">
      <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-6 text-3xl">✓</div>
      <h2 className="text-3xl font-bold mb-4 text-slate-800">Session Claimed</h2>
      <p className="text-slate-500 mb-8">Ready to trigger the C# bridge sequence.</p>
      <button onClick={handleStartRecording} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-lg transition-all shadow-sm flex justify-center items-center gap-2 text-lg">
        Start Session 🟢
      </button>
    </div>
  );

  const renderConnecting = () => (
    <div className="bg-white p-12 rounded-xl shadow-md border border-slate-200 max-w-2xl mx-auto text-center animate-in zoom-in-95">
      <h2 className="text-3xl font-bold mb-4 text-slate-800">Awaiting Bridge</h2>
      {isWaitingForBridge ? (
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div>
          <p className="text-blue-600 font-bold animate-pulse">Polling API for bridge_recording_at... ⏳</p>
        </div>
      ) : pollingError && (
        <div className="flex flex-col items-center gap-4">
          <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm font-medium uppercase tracking-wide">⚠️ {pollingError}</div>
          <button onClick={() => setCurrentStep("ready")} className="px-6 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg font-bold transition-colors">← Try Again</button>
        </div>
      )}
    </div>
  );

  const renderImageStimuli = () => {
    if (images.length === 0) {
      return (
        <div className="bg-white p-12 rounded-xl shadow-md border border-slate-200 max-w-4xl mx-auto text-center">
          <h2 className="text-2xl font-bold mb-4 text-slate-800">No images found in database!</h2>
          <button onClick={() => setCurrentStep("math")} className="px-6 py-2 bg-slate-200 rounded-lg font-bold">Skip to Math ⏭️</button>
        </div>
      );
    }

    const currentImg = images[currentImageIndex];
    const hasImage = currentImg.url && currentImg.url.trim() !== "";

    return (
      <div className="bg-white p-12 rounded-xl shadow-md border border-slate-200 max-w-4xl mx-auto text-center animate-in zoom-in-95">
        <div className="flex justify-between items-center mb-4 border-b border-slate-100 pb-4">
          <span className="text-slate-500 font-mono text-sm">
            Image {currentImageIndex + 1} of {images.length}
          </span>
          {currentImg.category && (
            <span className="text-sm font-medium text-slate-600 bg-slate-100 px-3 py-1 rounded-full">
              {currentImg.category}
            </span>
          )}
        </div>
        <div className="w-full h-96 bg-slate-100 rounded-lg flex items-center justify-center border border-slate-200 shadow-inner overflow-hidden relative">
          {hasImage ? (
            <img 
              src={currentImg.url} 
              alt={currentImg.filename || "Stimulus"} 
              className="w-full h-full object-contain" 
              onError={(e) => {
                e.target.style.display = 'none';
                const parent = e.target.parentNode;
                const fallback = document.createElement('div');
                fallback.className = 'text-slate-400 font-medium';
                fallback.textContent = 'Image not available';
                parent.appendChild(fallback);
              }} 
            />
          ) : (
            <div className="text-slate-400 font-medium">Image not available</div>
          )}
        </div>
      </div>
    );
  };

  const renderMathTest = () => {
    if (questions.length === 0) {
      return (
        <div className="bg-white p-12 rounded-xl shadow-md border border-slate-200 max-w-4xl mx-auto text-center">
          <p className="text-slate-500">Loading questions...</p>
        </div>
      );
    }
    const currentQ = questions[currentMathIndex];
    const answer = mathAnswers[currentMathIndex] || "";
    return (
      <div className="bg-white p-8 rounded-xl shadow-md border border-slate-200 max-w-4xl mx-auto animate-in zoom-in-95">
        <div className="flex justify-between items-center mb-6 border-b border-slate-100 pb-4">
          <span className="text-red-600 font-bold animate-pulse flex items-center gap-2"><span className="h-3 w-3 bg-red-600 rounded-full"></span>EEG RECORDING ACTIVE</span>
          <span className="text-slate-500 font-mono text-sm">Question {currentMathIndex + 1} of {questions.length}</span>
        </div>
        <div className="mb-4">
          <p className="text-3xl font-bold text-blue-600">{currentQ.prompt}</p>
          {currentQ.difficulty && (
            <p className="text-sm text-slate-500 mt-2">Difficulty: {currentQ.difficulty}</p>
          )}
        </div>
        <div className="mt-6">
          <input
            type="text"
            placeholder="Type your answer..."
            value={answer}
            onChange={(e) => handleMathAnswerChange(e.target.value)}
            disabled={!mathInputEnabled}
            className={`w-full p-3 border rounded-lg focus:ring-2 focus:ring-blue-500 ${!mathInputEnabled ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'border-slate-300'}`}
          />
          {!mathInputEnabled && (
            <p className="text-xs text-slate-400 mt-1">Input will be enabled in a few seconds to give you time to read...</p>
          )}
        </div>
        <div className="flex justify-end mt-6">
          <button
            onClick={handleNextMath}
            disabled={!mathInputEnabled || !answer.trim()}
            className={`bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-8 rounded-lg shadow-sm disabled:bg-slate-300 disabled:cursor-not-allowed`}
          >
            {currentMathIndex < questions.length - 1 ? "Next Question" : "Finish & End Session"}
          </button>
        </div>
      </div>
    );
  };

  const renderSurvey = () => {
    if (isLoadingData) {
      return (
        <div className="bg-white p-12 rounded-xl shadow-md border border-slate-200 max-w-4xl mx-auto text-center">
          <p className="text-slate-500">Loading survey...</p>
        </div>
      );
    }
    if (surveyComplete) {
      return (
        <div className="bg-white p-12 rounded-xl shadow-md border border-slate-200 max-w-4xl mx-auto text-center">
          <h2 className="text-2xl font-bold text-slate-800">Survey Submitted</h2>
          <p className="text-slate-500 mt-2">Redirecting to completion...</p>
        </div>
      );
    }
    if (surveyQuestions.length === 0) {
      return (
        <div className="bg-white p-12 rounded-xl shadow-md border border-slate-200 max-w-4xl mx-auto text-center">
          <p className="text-slate-500">No survey questions available.</p>
        </div>
      );
    }

    // Check if all answered
    const allAnswered = surveyQuestions.every(
      (_, idx) => surveyAnswers[idx] && surveyAnswers[idx].trim() !== ""
    );

    return (
      <div className="bg-white p-8 rounded-xl shadow-md border border-slate-200 max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-6 border-b border-slate-100 pb-4">
          <h2 className="text-2xl font-bold text-slate-800">Post‑Session Survey</h2>
          <div className="flex gap-2">
            {['en', 'ms', 'zh'].map(lang => (
              <button
                key={lang}
                onClick={() => handleLanguageChange(lang)}
                className={`px-3 py-1 text-xs font-bold rounded-full transition-colors ${
                  selectedLanguage === lang
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {lang.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-6">
          {surveyQuestions.map((q, idx) => {
            const statementObj = q.statement || {};
            const questionText = statementObj[selectedLanguage] || statementObj.en || "Question text not available";
            const answer = surveyAnswers[idx] || "";
            return (
              <div key={q.question_id || idx} className="mb-4">
                <p className="text-sm font-medium text-slate-700 mb-1">
                  {idx + 1}. {questionText}
                </p>
                <input
                  type="text"
                  placeholder="Your answer (number)"
                  value={answer}
                  onChange={(e) => setSurveyAnswers(prev => ({ ...prev, [idx]: e.target.value }))}
                  className="w-full p-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>
            );
          })}
        </div>

        <div className="flex justify-end pt-4 border-t border-slate-100 mt-6">
          <button
            onClick={handleSubmitSurvey}
            disabled={!allAnswered}
            className={`bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-8 rounded-lg shadow-sm disabled:bg-slate-300 disabled:cursor-not-allowed`}
          >
            Finish Survey
          </button>
        </div>
      </div>
    );
  };

  return (
    <main className="min-h-screen bg-slate-50 p-8 font-sans flex flex-col items-center justify-center">
      <div className="w-full max-w-6xl mb-8">
        <button onClick={() => router.push("/session")} className="text-slate-400 hover:text-slate-800 font-medium text-sm flex items-center gap-2">
          ← Abort Session
        </button>
      </div>
      <div className="w-full">
        {currentStep === "ready" && renderReadyState()}
        {currentStep === "connecting" && renderConnecting()}
        {currentStep === "images" && renderImageStimuli()}
        {currentStep === "math" && renderMathTest()}
        {currentStep === "survey" && renderSurvey()}
        {currentStep === "complete" && (
          <div className="text-center animate-in zoom-in">
            <div className="text-6xl mb-4">🎉</div>
            <h2 className="text-3xl font-bold text-slate-800 mb-2">Session Completed & Saved</h2>
            <button onClick={() => router.push("/history")} className="px-6 py-2 bg-slate-200 text-slate-700 rounded-lg font-bold mt-4">
              Return to Dashboard
            </button>
          </div>
        )}
      </div>
    </main>
  );
}