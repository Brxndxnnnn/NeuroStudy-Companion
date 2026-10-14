"use client";

/**
 * Likert survey: one radio group per statement, all statements on a single page,
 * optionally under a shared stem (BFI-2: "I am someone who…").
 *
 * The instrument text — answer labels, intro and stem — comes from the
 * questionnaire record (`options` / `instructions`, seeded by
 * db/migrations/024_bfi2_who5_questionnaires.sql), so the website and the bridge
 * show the same validated wording and nothing instrument-specific lives here.
 * ⚠ The ms/zh BFI-2 wording must still be verified against the official
 * published translations before clinical use (see that migration).
 */

// App-chrome label (not instrument text).
const ANSWERED_LABEL = { en: "answered", ms: "dijawab", zh: "已作答" };
const t = (dict, language) => (dict && (dict[language] || dict.en)) || "";

// Literal class names so Tailwind generates them; one column per answer option.
const KEY_COLUMNS = { 4: "sm:grid-cols-4", 5: "sm:grid-cols-5", 6: "sm:grid-cols-6", 7: "sm:grid-cols-7" };

// Build the [{value, label}] scale from the questionnaire's options for a language,
// English-fallback per label. Option order is the display order.
export function scaleFromOptions(options, language = "en") {
  return (options || []).map((o) => ({ value: o.value, label: t(o.label, language) }));
}

// A statement counts as answered once it has a value.
export function isAnswered(v) {
  return v != null && v !== "";
}

export function countAnswered(questions, answers) {
  return questions.reduce((n, _, idx) => (isAnswered(answers[idx]) ? n + 1 : n), 0);
}

export function allAnswered(questions, answers) {
  return questions.length > 0 && countAnswered(questions, answers) === questions.length;
}

export default function LikertSurvey({ questions, answers, onChange, options, instructions, language = "en" }) {
  const answered = countAnswered(questions, answers);
  const scale = scaleFromOptions(options, language);
  const intro = t(instructions?.intro, language);
  const stem = t(instructions?.stem, language);

  return (
    <div>
      {intro && <p className="text-[14px] leading-relaxed text-ink-2">{intro}</p>}

      {/* Scale key — the radios themselves only carry a number, so the meaning
          of each column has to live somewhere visible. */}
      <div className="mt-5 rounded-xl border border-border bg-inset/50 px-4 py-3">
        <div className={`grid grid-cols-1 ${KEY_COLUMNS[scale.length] || "sm:grid-cols-5"} gap-2`}>
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
        <h3 className="text-[17px] font-bold tracking-tight text-ink">{stem}</h3>
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
