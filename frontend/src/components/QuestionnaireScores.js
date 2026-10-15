"use client";
import { useEffect, useState } from "react";
import { getSessionQuestionnaires } from "@/utils/api";
import { Card, CardHeader, Label, Pill, Alert, Spinner } from "@/components/ui";

// WHO's screening cut-off: a percentage score below 50 (raw below 13) suggests poor well-being.
const WHO5_LOW_PERCENT = 50;

const fmt = (n, d = 2) => (n == null ? "—" : Number(n).toFixed(d).replace(/\.?0+$/, ""));

function ScoreBar({ value, min, max }) {
  const pct = Math.max(0, Math.min(100, ((Number(value) - min) / (max - min)) * 100));
  return (
    <div className="h-2 w-full rounded-full bg-inset overflow-hidden">
      <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
    </div>
  );
}

function Who5Scores({ q }) {
  const total = q.scores?.total;
  if (!total) return null;
  const low = total.percentage_score != null && Number(total.percentage_score) < WHO5_LOW_PERCENT;
  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <Label>Well-being score</Label>
          <div className="mt-2 text-[27px] font-bold tracking-tight tnum text-ink leading-none">
            {fmt(total.percentage_score, 0)}
            <span className="text-sm font-semibold text-muted ml-1">/ 100</span>
          </div>
        </div>
        <div>
          <Label>Raw score</Label>
          <div className="mt-2 text-[20px] font-bold tnum text-ink leading-none">
            {total.raw_score}
            <span className="text-sm font-semibold text-muted ml-1">/ {q.expected_items * q.scale_max}</span>
          </div>
        </div>
        <Pill tone={low ? "warn" : "good"} dot>
          {low ? "Low well-being (below 50)" : "Within normal range"}
        </Pill>
      </div>
      {!total.is_complete && (
        <p className="mt-3 text-[12px] text-muted">
          Only {total.answered_items} of {total.expected_items} items answered; the score is partial.
        </p>
      )}
    </div>
  );
}

function Bfi2Scores({ q }) {
  const { domains = [], facets = [] } = q.scores || {};
  if (domains.length === 0) return null;
  return (
    <div className="px-5 py-4">
      <div className="space-y-3">
        {domains.map((d) => (
          <div key={d.domain} className="grid grid-cols-[9rem_1fr_3rem] items-center gap-3">
            <span className="text-[13px] font-semibold text-ink">{d.domain_name || d.domain}</span>
            <ScoreBar value={d.mean_score} min={q.scale_min} max={q.scale_max} />
            <span className="font-mono text-[13px] font-bold text-ink tnum text-right">{fmt(d.mean_score)}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12px] text-muted">
        Mean item score per domain, {q.scale_min} to {q.scale_max}. Reverse-keyed items are already flipped.
      </p>
      {facets.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[13px] font-semibold text-accent">Facet scores</summary>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
            {facets.map((f) => (
              <div key={`${f.domain}-${f.facet}`} className="flex items-center justify-between gap-3 text-[13px]">
                <span className="text-ink-2">
                  <span className="font-mono text-muted mr-1.5">{f.domain}</span>
                  {f.facet}
                </span>
                <span className="font-mono font-bold text-ink tnum">{fmt(f.mean_score)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** A session's questionnaire results (BFI-2 domains/facets, WHO-5 well-being), from GET /api/sessions/:id/questionnaires. */
export default function QuestionnaireScores({ sessionId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await getSessionQuestionnaires(sessionId);
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.json();
        if (!cancelled) setData(body);
      } catch {
        if (!cancelled) setError("Couldn't load the questionnaire scores.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (error)
    return (
      <Card className="p-6">
        <Alert tone="warn">{error}</Alert>
      </Card>
    );
  if (!data)
    return (
      <Card className="p-6 flex items-center justify-center text-muted font-medium">
        <Spinner size={18} className="mr-2" /> Loading questionnaires…
      </Card>
    );

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Questionnaires"
        subtitle="Post-session self-report scores, calculated from the technician-entered answers."
      />
      {data.map((q) => (
        <div key={q.questionnaire_id} className="border-t border-border first:border-t-0">
          <div className="flex items-center justify-between gap-3 px-5 pt-4">
            <h3 className="text-[15px] font-semibold text-ink">{q.name}</h3>
            {q.answered_items === 0 ? (
              <Pill tone="neutral">Not answered</Pill>
            ) : q.is_complete ? (
              <Pill tone="good">Complete</Pill>
            ) : (
              <Pill tone="warn">
                {q.answered_items} / {q.expected_items} answered
              </Pill>
            )}
          </div>
          {q.code === "who5" ? <Who5Scores q={q} /> : <Bfi2Scores q={q} />}
        </div>
      ))}
    </Card>
  );
}
