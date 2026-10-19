
"use client";

import { useEffect, useState } from "react";
import { getSessionQuestionnaires } from "@/utils/api";
import {
  Card,
  CardHeader,
  Alert,
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


export default function QuestionnaireResults({ sessionId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Questionnaire results"
        subtitle="BFI-2 personality and WHO-5 well-being scores"
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

            return (
              <section
                key={q.questionnaire_id || code || index}
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
