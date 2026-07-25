"use client";

/**
 * BFI-style Likert survey: one 1–5 radio group per statement, all statements on
 * a single page under a shared "I am someone who…" stem.
 */
// ── BFI-2 instrument text, per language ───────────────────────────────────────
// ⚠ INSTRUMENT WORDING: the intro paragraph and the five anchor labels below are
// part of the BFI-2, a validated instrument whose response scale is calibrated.
// The ms/zh renderings here are ordinary translations and MUST be verified against
// the official published BFI-2 Malay/Chinese versions before use in a real clinical
// session — otherwise ms/zh responses are not comparable to the English norms. The
// statements themselves are already stored per-language in the database; only this
// surrounding instrument text lived in code.

// Anchor labels keyed by scale value, per language.
const SCALE_LABELS = {
  en: ["Disagree strongly", "Disagree a little", "Neutral; no opinion", "Agree a little", "Agree strongly"],
  ms: ["Sangat tidak setuju", "Kurang setuju", "Berkecuali; tiada pendapat", "Sedikit setuju", "Sangat setuju"],
  zh: ["非常不同意", "有点不同意", "中立；没有意见", "有点同意", "非常同意"],
};

export const LIKERT_VALUES = [1, 2, 3, 4, 5];

// Build the [{value, label}] scale for a given language, English-fallback per label.
export function likertScale(language = "en") {
  const labels = SCALE_LABELS[language] || SCALE_LABELS.en;
  return LIKERT_VALUES.map((value, i) => ({
    value,
    label: labels[i] || SCALE_LABELS.en[i],
  }));
}

// Retained for existing importers; English scale, same shape as before.
export const LIKERT_SCALE = likertScale("en");

const SURVEY_INTRO_BY_LANG = {
  en: "Here are a number of characteristics that may or may not apply to you. For example, do you agree that you are someone who likes to spend time with others? Please select a number next to each statement to indicate the extent to which you agree or disagree with that statement.",
  ms: "Berikut adalah beberapa ciri yang mungkin atau mungkin tidak menggambarkan diri anda. Sebagai contoh, adakah anda bersetuju bahawa anda seorang yang suka meluangkan masa bersama orang lain? Sila pilih nombor di sebelah setiap pernyataan untuk menunjukkan sejauh mana anda bersetuju atau tidak bersetuju dengan pernyataan tersebut.",
  zh: "以下是一些可能适合或不适合您的特征。例如，您是否同意自己是一个喜欢与他人共处的人？请在每个陈述旁选择一个数字，以表明您对该陈述同意或不同意的程度。",
};

export const SURVEY_INTRO = SURVEY_INTRO_BY_LANG.en;

// The shared stem ("I am someone who…") and the answered-counter label.
const STEM = { en: "I am someone who…", ms: "Saya seorang yang…", zh: "我是一个…" };
const ANSWERED_LABEL = { en: "answered", ms: "dijawab", zh: "已作答" };
const t = (dict, language) => dict[language] || dict.en;

// A statement counts as answered once it has a value in 1–5.
export function isAnswered(v) {
  return v != null && v !== "";
}

export function countAnswered(questions, answers) {
  return questions.reduce((n, _, idx) => (isAnswered(answers[idx]) ? n + 1 : n), 0);
}

export function allAnswered(questions, answers) {
  return questions.length > 0 && countAnswered(questions, answers) === questions.length;
}

export default function LikertSurvey({ questions, answers, onChange, language = "en" }) {
  const answered = countAnswered(questions, answers);
  const scale = likertScale(language);

  return (
    <div>
      <p className="text-[14px] leading-relaxed text-ink-2">{t(SURVEY_INTRO_BY_LANG, language)}</p>

      {/* Scale key — the radios themselves only carry a number, so the meaning
          of each column has to live somewhere visible. */}
      <div className="mt-5 rounded-xl border border-border bg-inset/50 px-4 py-3">
        <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
          {scale.map((o) => (
            <div key={o.value} className="flex items-center gap-2">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-surface border border-border-strong font-mono text-[11px] font-bold text-ink tnum">
                {o.value}
              </span>
              <span className="text-[12px] text-ink-2 leading-tight">{o.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6 flex items-baseline justify-between gap-4">
        <h3 className="text-[17px] font-bold tracking-tight text-ink">{t(STEM, language)}</h3>
        <span className="font-mono text-[12px] text-muted tnum shrink-0">
          {answered} / {questions.length} {t(ANSWERED_LABEL, language)}
        </span>
      </div>

      <ol className="mt-2 divide-y divide-border">
        {questions.map((q, idx) => {
          const statement = q.statement || {};
          const text = statement[language] || statement.en || "Statement not available";
          const current = answers[idx];
          const groupName = `q-${q.question_id || idx}`;

          return (
            <li
              key={q.question_id || idx}
              className="grid gap-2.5 py-4 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-6"
            >
              <p className="text-[15px] text-ink leading-snug">
                <span className="font-mono text-[12px] text-muted tnum mr-2">{idx + 1}.</span>
                {text}
              </p>

              <fieldset className="flex gap-1.5 shrink-0">
                <legend className="sr-only">{text}</legend>
                {scale.map((o) => {
                  const selected = Number(current) === o.value;
                  return (
                    <label
                      key={o.value}
                      title={o.label}
                      className={`grid h-9 w-9 cursor-pointer place-items-center rounded-lg border font-mono text-[13px] font-bold tnum transition-colors ${
                        selected
                          ? "border-accent bg-accent text-on-accent"
                          : "border-border-strong bg-surface text-ink-2 hover:border-accent hover:text-accent"
                      }`}
                    >
                      <input
                        type="radio"
                        name={groupName}
                        value={o.value}
                        checked={selected}
                        onChange={() => onChange(idx, o.value)}
                        aria-label={`${o.value} — ${o.label}`}
                        className="sr-only"
                      />
                      {o.value}
                    </label>
                  );
                })}
              </fieldset>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
