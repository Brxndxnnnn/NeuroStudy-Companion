"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  getQuestionnaires,
  getQuestionnaireQuestions,
  submitQuestionnaireAnswers,
} from "@/utils/api";
import { SessionTopBar } from "@/components/TopNav";
import { Card, Button, Spinner } from "@/components/ui";
import LikertSurvey, { allAnswered as allSurveyAnswered } from "@/components/LikertSurvey";

export default function QuestionnairePage() {
  const router = useRouter();

  const [surveyQuestions, setSurveyQuestions] = useState([]);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [surveyComplete, setSurveyComplete] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState("en");
  const [selectedQuestionnaireId, setSelectedQuestionnaireId] = useState("");
  const [surveyAnswers, setSurveyAnswers] = useState({});

  // Load the questionnaire + its questions on mount.
  useEffect(() => {
    const fetchSurveyData = async () => {
      setIsLoadingData(true);
      try {
        const qRes = await getQuestionnaires();
        if (!qRes.ok) throw new Error("Failed to fetch questionnaires");
        const qData = await qRes.json();

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    } catch (err) {
      console.error("Error submitting survey:", err);
      alert("Network error. Please try again.");
    }
  };

  const ready = allSurveyAnswered(surveyQuestions, surveyAnswers);

  const renderBody = () => {
    if (isLoadingData) {
      return (
        <div className="py-8 text-center">
          <Spinner size={22} className="text-accent" />
          <p className="text-muted mt-3">Loading survey…</p>
        </div>
      );
    }
    if (surveyComplete) {
      return (
        <div className="py-8 text-center">
          <div className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-full bg-good-soft text-good text-2xl">✓</div>
          <h2 className="text-xl font-bold text-ink">Survey submitted</h2>
          <p className="text-muted mt-2 mb-6">Thank you — your responses have been saved.</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button onClick={() => router.push("/session/result")}>View session results →</Button>
            <Button variant="subtle" onClick={() => router.push("/history")}>Return to dashboard</Button>
          </div>
        </div>
      );
    }
    if (surveyQuestions.length === 0) {
      return <p className="py-8 text-center text-muted">No survey questions available.</p>;
    }

    return (
      <>
        <LikertSurvey
          questions={surveyQuestions}
          answers={surveyAnswers}
          language={selectedLanguage}
          onChange={(idx, value) => setSurveyAnswers((prev) => ({ ...prev, [idx]: value }))}
        />
        <div className="flex justify-end pt-5 mt-6 border-t border-border">
          <Button onClick={handleSubmitSurvey} disabled={!ready}>Finish survey</Button>
        </div>
      </>
    );
  };

  return (
    <main className="min-h-screen bg-ground flex flex-col">
      <SessionTopBar onBack={() => router.push("/history")} backLabel="Dashboard" />
      <div className="flex-1 flex items-start justify-center px-5 py-10">
        <Card className="w-full max-w-3xl p-8 anim-rise">
          <div className="flex justify-between items-center mb-6 pb-4 border-b border-border">
            <h1 className="text-xl font-bold tracking-tight text-ink">Post-session survey</h1>
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
          {renderBody()}
        </Card>
      </div>
    </main>
  );
}
