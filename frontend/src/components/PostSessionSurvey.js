"use client";
import { useState, useEffect } from "react";
import {
  getQuestionnaires,
  getQuestionnaireQuestions,
  submitQuestionnaireAnswers,
} from "@/utils/api";
import { Button, Spinner, Alert } from "@/components/ui";
import LikertSurvey, { allAnswered as allSurveyAnswered } from "@/components/LikertSurvey";

/**
 * The BFI-style post-session survey: fetches the active questionnaire, lets
 * the technician switch language, and submits answers for `sessionId`.
 *
 * Shared by the standalone /questionare page and the survey step inside the
 * active-session flow — those two previously carried independent copies of
 * this fetch/submit logic that had already started to drift.
 *
 * The "submitted" state is intentionally NOT owned here: the two callers show
 * different things after a successful submit (one offers "view results" /
 * "return to dashboard" buttons, the other advances its own step machine), so
 * this component just renders the form and calls onSubmitted() once, leaving
 * what happens next to the caller.
 */
export default function PostSessionSurvey({ sessionId, onSubmitted }) {
  const [language, setLanguage] = useState("en");
  const [questionnaireId, setQuestionnaireId] = useState("");
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const fetchQuestionsForSurvey = async (id, lang) => {
    try {
      const res = await getQuestionnaireQuestions(id, lang);
      if (res.ok) {
        setQuestions(await res.json());
        setAnswers({});
      } else {
        setQuestions([]);
      }
    } catch (err) {
      console.error("Error fetching survey questions:", err);
    }
  };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const qRes = await getQuestionnaires();
        if (!qRes.ok) throw new Error("Failed to fetch questionnaires");
        const qData = await qRes.json();
        if (qData.length > 0) {
          const firstId = qData[0].questionnaire_id || qData[0].id;
          setQuestionnaireId(firstId);
          await fetchQuestionsForSurvey(firstId, language);
        }
      } catch (err) {
        console.error("Error loading survey:", err);
      } finally {
        setLoading(false);
      }
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeLanguage = (lang) => {
    setLanguage(lang);
    if (questionnaireId) fetchQuestionsForSurvey(questionnaireId, lang);
  };

  const ready = allSurveyAnswered(questions, answers);

  const submit = async () => {
    if (!ready) {
      setError("Please answer all questions before finishing.");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      const payload = questions.map((q, idx) => ({
        question_id: q.question_id,
        answer_value: Number(answers[idx]),
      }));
      const res = await submitQuestionnaireAnswers(sessionId, questionnaireId, payload);
      if (!res.ok) {
        console.error("Failed to submit survey", await res.text());
        setError("Failed to submit survey. Please try again.");
        return;
      }
      onSubmitted();
    } catch (err) {
      console.error("Error submitting survey:", err);
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="flex justify-between items-center mb-6 pb-4 border-b border-border">
        <h2 className="text-xl font-bold tracking-tight text-ink">Post-session survey</h2>
        <div className="flex gap-1.5">
          {["en", "ms", "zh"].map((lang) => (
            <button
              key={lang}
              onClick={() => changeLanguage(lang)}
              className={`px-3 py-1 text-[11px] font-bold rounded-full transition-colors ${
                language === lang ? "bg-accent text-on-accent" : "bg-inset text-ink-2 hover:bg-border/60"
              }`}
            >
              {lang.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="py-8 text-center">
          <Spinner size={22} className="text-accent" />
          <p className="text-muted mt-3">Loading survey…</p>
        </div>
      ) : questions.length === 0 ? (
        <p className="py-8 text-center text-muted">No survey questions available.</p>
      ) : (
        <>
          {error && <Alert tone="warn" className="mb-5">{error}</Alert>}
          <LikertSurvey
            questions={questions}
            answers={answers}
            language={language}
            onChange={(idx, value) => setAnswers((prev) => ({ ...prev, [idx]: value }))}
          />
          <div className="flex justify-end pt-5 mt-6 border-t border-border">
            <Button onClick={submit} loading={submitting} disabled={!ready}>
              Finish survey
            </Button>
          </div>
        </>
      )}
    </>
  );
}
