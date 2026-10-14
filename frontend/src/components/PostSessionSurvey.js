"use client";
import { useState, useEffect } from "react";
import {
  getQuestionnaires,
  getQuestionnaireQuestions,
  submitQuestionnaireAnswers,
} from "@/utils/api";
import { Button, Spinner, Alert } from "@/components/ui";
import LikertSurvey, { allAnswered as allSurveyAnswered } from "@/components/LikertSurvey";

// App-chrome strings (not part of the BFI-2 instrument — safe to translate directly;
// the instrument text comes from the questionnaire record). English-fallback per key.
const UI = {
  title:        { en: "Post-session survey", ms: "Tinjauan selepas sesi", zh: "疗程后问卷" },
  loading:      { en: "Loading survey…", ms: "Memuatkan tinjauan…", zh: "正在加载问卷…" },
  none:         { en: "No survey questions available.", ms: "Tiada soalan tinjauan tersedia.", zh: "没有可用的问卷题目。" },
  finish:       { en: "Finish survey", ms: "Selesaikan tinjauan", zh: "完成问卷" },
  errIncomplete:{ en: "Please answer all questions before finishing.", ms: "Sila jawab semua soalan sebelum menyelesaikan.", zh: "请在完成前回答所有题目。" },
  errSubmit:    { en: "Failed to submit survey. Please try again.", ms: "Gagal menghantar tinjauan. Sila cuba lagi.", zh: "提交问卷失败，请重试。" },
  errNetwork:   { en: "Network error. Please try again.", ms: "Ralat rangkaian. Sila cuba lagi.", zh: "网络错误，请重试。" },
};
const tr = (key, lang) => UI[key][lang] || UI[key].en;

// The questionnaire this survey presents, selected by its stable code rather than
// its position in the list.
const SURVEY_CODE = "bfi2";

/**
 * The BFI-2 post-session survey: fetches the BFI-2 questionnaire (by code), lets
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
  // { questionnaire_id, options, instructions, ... } from GET /api/questionnaires.
  const [questionnaire, setQuestionnaire] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Fetch once. The API returns every language's statement text in one payload
  // (the backend defaults to all languages when none is requested), so switching
  // language is a pure client-side re-render — no refetch, and answers are kept.
  const fetchQuestionsForSurvey = async (id) => {
    try {
      const res = await getQuestionnaireQuestions(id);
      setQuestions(res.ok ? await res.json() : []);
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
        const survey = qData.find((q) => q.code === SURVEY_CODE);
        // Without its answer options the survey cannot be answered, so it is treated
        // as unavailable rather than rendered with no scale.
        if (survey && survey.options?.length > 0) {
          setQuestionnaire(survey);
          await fetchQuestionsForSurvey(survey.questionnaire_id);
        }
      } catch (err) {
        console.error("Error loading survey:", err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Language is display-only: the statements already carry every language, so a
  // switch re-renders in place and NEVER touches the answers the technician entered.
  const changeLanguage = (lang) => setLanguage(lang);

  const ready = allSurveyAnswered(questions, answers);

  const submit = async () => {
    if (!ready) {
      setError(tr("errIncomplete", language));
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      const payload = questions.map((q, idx) => ({
        question_id: q.question_id,
        answer_value: Number(answers[idx]),
      }));
      const res = await submitQuestionnaireAnswers(sessionId, questionnaire.questionnaire_id, payload);
      if (!res.ok) {
        console.error("Failed to submit survey", await res.text());
        setError(tr("errSubmit", language));
        return;
      }
      onSubmitted();
    } catch (err) {
      console.error("Error submitting survey:", err);
      setError(tr("errNetwork", language));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="flex justify-between items-center mb-6 pb-4 border-b border-border">
        <h2 className="text-xl font-bold tracking-tight text-ink">{tr("title", language)}</h2>
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
          <p className="text-muted mt-3">{tr("loading", language)}</p>
        </div>
      ) : !questionnaire || questions.length === 0 ? (
        <p className="py-8 text-center text-muted">{tr("none", language)}</p>
      ) : (
        <>
          {error && <Alert tone="warn" className="mb-5">{error}</Alert>}
          <LikertSurvey
            questions={questions}
            answers={answers}
            options={questionnaire.options}
            instructions={questionnaire.instructions}
            language={language}
            onChange={(idx, value) => setAnswers((prev) => ({ ...prev, [idx]: value }))}
          />
          <div className="flex justify-end pt-5 mt-6 border-t border-border">
            <Button onClick={submit} loading={submitting} disabled={!ready}>
              {tr("finish", language)}
            </Button>
          </div>
        </>
      )}
    </>
  );
}
