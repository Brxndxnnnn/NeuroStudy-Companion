
"use client";

import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import {
  getSessionQuestionnaires,
  getSessionQuestionnairesPdf,
} from "@/utils/api";
import {
  Card,
  CardHeader,
  Alert,
  Button,
  Spinner,
} from "@/components/ui";

// Friendly names for BFI-2 domains
const DOMAIN_NAMES = {
  E: "Extraversion",
  A: "Agreeableness",
  C: "Conscientiousness",
  N: "Negative Emotionality",
  O: "Open-Mindedness",
};

function prettyName(key) {
  return (
    DOMAIN_NAMES[key] ||
    String(key)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

// Extract questionnaire records from common API shapes.
// We will confirm the exact shape with Eugene's response.
function getQuestionnaireRows(payload) {
  const body = payload?.data ?? payload;

  if (Array.isArray(body)) return body;

  for (const key of ["questionnaires", "results", "scores"]) {
    if (Array.isArray(body?.[key])) {
      return body[key];
    }
  }

  if (body && (body.bfi2 || body.who5)) {
    return ["bfi2", "who5"]
      .filter((code) => body[code])
      .map((code) => ({
        code,
        ...body[code],
      }));
  }

  return [];
}

// Display scores provided by backend.
// No calculation is performed here.

function getScoreFields(row) {
  // BFI-2: Five personality domain scores
  if (row.code === "bfi2") {
    const domains = row.scores?.domains ?? [];

    return domains
      .filter((domain) =>
        typeof domain.mean_score === "number"
      )
      .map((domain) => ({
        label:
          domain.domain_name ||
          prettyName(domain.domain),
        value: domain.mean_score,
        max: 5,
      }));
  }

  // WHO-5: Well-being score and raw score
  if (row.code === "who5") {
    const total = row.scores?.total;

    if (!total) {
      return [];
    }

    const results = [];

    if (typeof total.percentage_score === "number") {
      results.push({
        label: "WHO-5 Well-being Score",
        value: total.percentage_score,
        max: 100,
      });
    }

    if (typeof total.raw_score === "number") {
      results.push({
        label: "Raw Score",
        value: total.raw_score,
        max: 25,
      });
    }

    return results;
  }

  return [];
}

// Statements and option labels are stored per language ({ en, ms, zh }).
function english(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") {
    return value.en ?? Object.values(value)[0] ?? "—";
  }
  return String(value);
}

function answerLabel(row, value) {
  const option = (row.options ?? []).find((o) => o.value === value);
  return option ? `${value} — ${english(option.label)}` : String(value ?? "—");
}

// Every question with the answer given and the score it contributes. BFI-2 items
// also show their domain and facet; reverse-keyed items are marked (R).
function ResponsesTable({ row }) {
  const answers = row.answers ?? [];
  const hasDomains = answers.some((a) => a.domain);

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full text-sm">
        <thead className="bg-inset text-left text-xs text-muted">
          <tr>
            <th className="px-3 py-2 text-right font-semibold">#</th>
            <th className="px-3 py-2 font-semibold">Statement</th>
            {hasDomains && (
              <th className="px-3 py-2 font-semibold">Domain · Facet</th>
            )}
            <th className="px-3 py-2 font-semibold">Answer</th>
            <th className="px-3 py-2 text-right font-semibold">Score</th>
          </tr>
        </thead>
        <tbody>
          {answers.map((a) => (
            <tr
              key={a.question_id ?? a.question_no}
              className="border-t border-border"
            >
              <td className="px-3 py-2 text-right font-mono text-muted">
                {a.question_no}
              </td>
              <td className="px-3 py-2 text-ink">{english(a.statement)}</td>
              {hasDomains && (
                <td className="px-3 py-2 text-muted">
                  {[DOMAIN_NAMES[a.domain] ?? a.domain, a.facet]
                    .filter(Boolean)
                    .join(" · ")}
                </td>
              )}
              <td className="px-3 py-2 text-ink">
                {answerLabel(row, a.answer_value)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-ink">
                {a.item_score}
                {a.is_reverse_scored && (
                  <span
                    className="ml-1 text-xs text-muted"
                    title="Reverse-keyed: scored as (scale minimum + scale maximum - answer)"
                  >
                    (R)
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function QuestionnaireResults({ sessionId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState({});
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!sessionId) return;

    let active = true;

    setLoading(true);
    setError("");
    setData(null);

    async function loadResults() {
      try {
        const res = await getSessionQuestionnaires(sessionId);

        if (res.status === 401) {
          throw new Error(
            "Please sign in to view questionnaire results."
          );
        }

        if (res.status === 403) {
          throw new Error(
            "You do not have permission to view this session."
          );
        }

        if (!res.ok) {
          throw new Error(
            `Failed to load questionnaire results (${res.status}).`
          );
        }

        const result = await res.json();

        if (active) {
          setData(result);
        }
      } catch (err) {
        if (active) {
          setError(
            err.message || "Unable to load questionnaire results."
          );
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    loadResults();

    return () => {
      active = false;
    };
  }, [sessionId]);

  const questionnaires = getQuestionnaireRows(data);
  const anyAnswered = questionnaires.some(
    (q) => (q.answers?.length ?? 0) > 0
  );

  const handleExportPdf = async () => {
    setExporting(true);
    const toastId = toast.loading("Generating questionnaire PDF…");
    try {
      const res = await getSessionQuestionnairesPdf(sessionId);
      if (res.status === 409) {
        toast.error("No questionnaire has been answered for this session yet.", { id: toastId });
        return;
      }
      if (!res.ok) throw new Error(`PDF export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `questionnaire-responses-${sessionId}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Questionnaire PDF downloaded.", { id: toastId });
    } catch (err) {
      console.error("Failed to export questionnaire PDF:", err);
      toast.error("Failed to export the questionnaire PDF.", { id: toastId });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Questionnaire results"
        subtitle="BFI-2 personality and WHO-5 well-being scores and responses"
        actions={
          anyAnswered && (
            <Button
              variant="ghost"
              size="sm"
              loading={exporting}
              onClick={handleExportPdf}
            >
              Export as PDF
            </Button>
          )
        }
      />

      <div className="p-5 space-y-4">
        {loading ? (
          <div className="flex items-center gap-3 text-muted">
            <Spinner size={18} />
            Loading questionnaire scores...
          </div>
        ) : error ? (
          <Alert tone="warn">{error}</Alert>
        ) : questionnaires.length === 0 ? (
          <p className="text-sm text-muted">
            No questionnaire results were found,
            or the API response format needs mapping.
          </p>
        ) : (
          questionnaires.map((q, index) => {
            const code = String(
              q.code ?? q.questionnaire_code ?? ""
            ).toLowerCase();

            const title =
              q.questionnaire_name ??
              q.name ??
              (code === "bfi2"
                ? "BFI-2"
                : code === "who5"
                  ? "WHO-5"
                  : `Questionnaire ${index + 1}`);

            const scores = getScoreFields(q);
            const key = q.questionnaire_id || code || index;
            const answerCount = q.answers?.length ?? 0;
            const isOpen = !!expanded[key];

            return (
              <section
                key={key}
                className="rounded-xl border border-border bg-inset/40 p-4"
              >
                <h3 className="font-semibold text-ink mb-3">
                  {title}
                </h3>

                {scores.length > 0 ? (
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {scores.map((item) => (
                      <div
                        key={item.label}
                        className="rounded-lg border border-border bg-surface px-3 py-2"
                      >
                        <dt className="text-xs text-muted">
                          {item.label}
                        </dt>

                        
                        <dd className="font-mono text-lg font-semibold text-ink">
                        {Number.isInteger(item.value)
                            ? item.value
                            : item.value.toFixed(2)}

                        <span className="ml-1 text-sm font-normal text-muted">
                            / {item.max}
                        </span>
                        </dd>

                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="text-sm text-muted">
                    Scores are not yet available,
                    or the response requires field mapping.
                  </p>
                )}

                {answerCount > 0 && (
                  <div className="mt-4 space-y-3">
                    <Button
                      variant="subtle"
                      size="sm"
                      aria-expanded={isOpen}
                      onClick={() =>
                        setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))
                      }
                    >
                      {isOpen
                        ? "Hide responses"
                        : `Show responses (${answerCount})`}
                    </Button>
                    {isOpen && <ResponsesTable row={q} />}
                  </div>
                )}
              </section>
            );
          })
        )}

        <p className="text-xs text-muted">
          Questionnaire scores are self-reported measures,
          not medical diagnoses.
        </p>
      </div>
    </Card>
  );
}
