"use client";
import { useState, useEffect, useRef  } from "react";
import {
  getQuestionnaires,
  getQuestionnaireQuestions,
  submitQuestionnaireAnswers,
} from "@/utils/api";
import { Button, Spinner, Alert } from "@/components/ui";
import LikertSurvey, { allAnswered as allSurveyAnswered } from "@/components/LikertSurvey";


// App-chrome strings (not part of the BFI-2 instrument — safe to translate directly;
// the instrument text lives in LikertSurvey.js). English-fallback per key.
const UI = {
  title:        { en: "Post-session survey", ms: "Tinjauan selepas sesi", zh: "疗程后问卷" },
  loading:      { en: "Loading survey…", ms: "Memuatkan tinjauan…", zh: "正在加载问卷…" },
  none:         { en: "No survey questions available.", ms: "Tiada soalan tinjauan tersedia.", zh: "没有可用的问卷题目。" },
  finish:       { en: "Finish survey", ms: "Selesaikan tinjauan", zh: "完成问卷" },
  errIncomplete:{ en: "Please answer all questions before finishing.", ms: "Sila jawab semua soalan sebelum menyelesaikan.", zh: "请在完成前回答所有题目。" },
  errSubmit:    { en: "Failed to submit survey. Please try again.", ms: "Gagal menghantar tinjauan. Sila cuba lagi.", zh: "提交问卷失败，请重试。" },
  errNetwork:   { en: "Network error. Please try again.", ms: "Ralat rangkaian. Sila cuba lagi.", zh: "网络错误，请重试。" },

  next:         { en: "Save BFI-2 and continue to WHO-5" , ms: "Simpan BFI-2 dan teruskan ke WHO-5" , zh: "保存 BFI-2 并继续 WHO-5",},
  stepBfi:      { en: "Step 1 of 2 — BFI-2" , ms: "Langkah 1 daripada 2 — BFI-2" , zh: "第 1 步（共 2 步）— BFI-2",},
  stepWho5:     { en: "Step 2 of 2 — WHO-5" , ms: "Langkah 2 daripada 2 — WHO-5" , zh: "第 2 步（共 2 步）— WHO-5",},
  noWho5:       { en: "WHO-5 is not available yet. Please contact the administrator." , ms: "WHO-5 belum tersedia. Sila hubungi pentadbir." , zh: "WHO-5 尚未准备好，请联系管理员。",},
  noSession:    { en: "Session ID is missing. Please open a valid session." , ms: "ID sesi tiada. Sila buka sesi yang sah." , zh: "缺少会话 ID，请打开有效会话。",}
};
const tr = (key, lang) => UI[key][lang] || UI[key].en;

const BFI_CODE = "bfi2";
const WHO5_CODE = "who5";

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
  const [questionnaire, setQuestionnaire] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");


  const [who5QuestionnaireId, setWho5QuestionnaireId] = useState("");
  const [who5Questionnaire, setWho5Questionnaire] = useState(null);
  const [who5Questions, setWho5Questions] = useState([]);
  const [who5Answers, setWho5Answers] = useState({});
  const [step, setStep] = useState("bfi");

  // Move to top when moving to next step
  const surveyTopRef = useRef(null);

  useEffect(() => {
    if (step === "who5") {
      surveyTopRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  }, [step]);


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

        if (!Array.isArray(qData)) {
          throw new Error("Invalid questionnaire list");
        }

        // Find both questionnaires using Eugene's codes
        const bfi = qData.find((q) => q.code === BFI_CODE);
        const who5 = qData.find((q) => q.code === WHO5_CODE);

        // Check BFI-2 and its five answer options
        if (!bfi?.questionnaire_id || bfi.options?.length !== 5) {
          throw new Error("BFI-2 or its answer options are missing");
        }

        // Save BFI metadata and load existing questions
        setQuestionnaire(bfi);
        await fetchQuestionsForSurvey(bfi.questionnaire_id);

        // Load WHO-5 if it has six answer options
        if (who5?.questionnaire_id && who5.options?.length === 6) {
          const who5Res = await getQuestionnaireQuestions(
            who5.questionnaire_id
          );

          if (!who5Res.ok) {
            throw new Error("Failed to fetch WHO-5 questions");
          }

          const items = await who5Res.json();

          setWho5QuestionnaireId(who5.questionnaire_id);
          setWho5Questionnaire(who5);
          setWho5Questions(Array.isArray(items) ? items : []);
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

  const isWho5 = step === "who5";

  const activeQuestions = isWho5
    ? who5Questions
    : questions;

  const activeAnswers = isWho5
    ? who5Answers
    : answers;

  const activeQuestionnaire = isWho5
  ? who5Questionnaire
  : questionnaire;

// Check whether WHO-5 has been loaded correctly
const who5Available =
  Boolean(who5QuestionnaireId) &&
  who5Questions.length === 5 &&
  who5Questionnaire?.options?.length === 6;

// Check all required answers and their allowed values
const ready =
  Boolean(activeQuestionnaire?.options?.length) &&
  activeQuestions.length === (isWho5 ? 5 : 60) &&
  allSurveyAnswered(activeQuestions, activeAnswers) &&
  activeQuestions.every((_, idx) =>
    activeQuestionnaire.options.some(
      (option) =>
        Number(option.value) === Number(activeAnswers[idx])
    )
  );

  const submit = async () => {
    if (submitting) return;

    if (!sessionId) {
      setError(tr("noSession", language));
      return;
    }

    if (!who5Available) {
      setError(tr("noWho5", language));
      return;
    }

    if (!ready) {
      setError(tr("errIncomplete", language));
      return;
    }

    setError("");
    setSubmitting(true);

    try {
      const payload = activeQuestions.map((q, idx) => ({
        question_id: q.question_id,
        answer_value: Number(activeAnswers[idx]),
      }));

      const res = await submitQuestionnaireAnswers(
        sessionId,
        activeQuestionnaire.questionnaire_id,
        payload
      );

      if (!res.ok) {
        console.error(
          "Failed to submit survey",
          await res.text()
        );

        setError(tr("errSubmit", language));
        return;
      }

      // After BFI succeeds, show WHO-5.
      // Only complete after WHO-5 succeeds.
      if (isWho5) {
        onSubmitted();
      } else {
        setStep("who5");
      }
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
      ) : !questionnaire?.options?.length || questions.length !== 60 ? (
        <p className="py-8 text-center text-muted">{tr("none", language)}</p>
      ) : (
        <>
          {error && <Alert tone="warn" className="mb-5">{error}</Alert>}
          {!who5Available && (
            <Alert tone="warn" className="mb-5">
              {tr("noWho5", language)}
            </Alert>
          )}

          {/*Current questionnaire indicator */}
          <p
            ref={surveyTopRef}
            className="mb-5 text-sm font-semibold text-accent"
          >
            {tr(
              isWho5 ? "stepWho5" : "stepBfi",
              language
            )}
          </p>

          {/*Display the correct questionnaire */}
          <LikertSurvey
            questions={activeQuestions}
            answers={activeAnswers}
            options={activeQuestionnaire.options}
            instructions={activeQuestionnaire.instructions}
            language={language}
            onChange={(idx, value) => {
              if (isWho5) {
                setWho5Answers((prev) => ({
                  ...prev,
                  [idx]: value,
                }));
              } else {
                setAnswers((prev) => ({
                  ...prev,
                  [idx]: value,
                }));
              }
            }}
          />

          {/* Existing button, now with dynamic label */}
          <div className="flex justify-end pt-5 mt-6 border-t border-border">
            <Button
              onClick={submit}
              loading={submitting}
              disabled={
                !ready ||
                submitting ||
                !sessionId ||
                !who5Available
              }
            >
              {tr(
                isWho5 ? "finish" : "next",
                language
              )}
            </Button>
          </div>
        </>
      )}
    </>
  );
}