"use client";

/**
 * BFI-style Likert survey: one 1–5 radio group per statement, all statements on
 * a single page under a shared "I am someone who…" stem.
 */
export const LIKERT_SCALE = [
  { value: 1, label: "Disagree strongly", short: "Disagree strongly" },
  { value: 2, label: "Disagree a little", short: "Disagree a little" },
  { value: 3, label: "Neutral; no opinion", short: "Neutral" },
  { value: 4, label: "Agree a little", short: "Agree a little" },
  { value: 5, label: "Agree strongly", short: "Agree strongly" },
];

export const SURVEY_INTRO =
  "Here are a number of characteristics that may or may not apply to you. For example, do you agree that you are someone who likes to spend time with others? Please select a number next to each statement to indicate the extent to which you agree or disagree with that statement.";

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

  return (
    <div>
      <p className="text-[14px] leading-relaxed text-ink-2">{SURVEY_INTRO}</p>

      {/* Scale key — the radios themselves only carry a number, so the meaning
          of each column has to live somewhere visible. */}
      <div className="mt-5 rounded-xl border border-border bg-inset/50 px-4 py-3">
        <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
          {LIKERT_SCALE.map((o) => (
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
        <h3 className="text-[17px] font-bold tracking-tight text-ink">I am someone who…</h3>
        <span className="font-mono text-[12px] text-muted tnum shrink-0">
          {answered} / {questions.length} answered
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
                {LIKERT_SCALE.map((o) => {
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
