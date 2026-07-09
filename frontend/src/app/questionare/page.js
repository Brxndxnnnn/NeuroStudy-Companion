"use client";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import {
  fetchWithAuth,
  getImages,
  getQuestions,
  getQuestionnaires,
  getQuestionnaireQuestions,
  submitQuestionnaireAnswers,
} from "@/utils/api";

export default function ActiveSessionMockup() {
  const router = useRouter();
  
  const [currentStep, setCurrentStep] = useState("survey"); 
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

    // 4. FETCH SURVEY DATA (questionnaires & questions)
  useEffect(() => {
    if (currentStep === "survey" && !isLoadingData) {
      const fetchSurveyData = async () => {
        setIsLoadingData(true);
        try {
          // First, get all questionnaires
          const qRes = await getQuestionnaires();
          console.log(qRes)
          // Get questions for a specific questionnaire
          if (!qRes.ok) throw new Error("Failed to fetch questionnaires");
          const qData = await qRes.json();
          setQuestionnaires(qData);
          console.log(qData)

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
  const fetchQuestionsForSurvey = async (questionnaireId) => {
    try {
      console.log(questionnaireId)
      const res = await getQuestionnaireQuestions(questionnaireId);
      console.log(res)
      if (res.ok) {
        const data = await res.json();
        console.log(data)
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


}