"use client";
import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import {
  getSessionActiveCommentary,
  getSessionCommentaryDraft,
  saveSessionCommentaryDraft,
  publishSessionCommentaryDraft,
} from "@/utils/api";
import { Card, CardHeader, Button, Field, Textarea, Pill, Spinner } from "@/components/ui";

// Mirrors backend/src/validators/sessionCommentary.validators.js, in report order. Every
// section is required to publish; a draft may leave any of them empty.
const GROUPS = [
  {
    fields: [{ key: "anamnesis", label: "Anamnesis" }],
  },
  {
    title: "EEG Pre Measurement",
    fields: [
      { key: "eeg_premeasurement", label: "EEG Premeasurement" },
      { key: "eeg_eyes_closed", label: "Resting state recording with eyes closed" },
      { key: "eeg_eyes_open", label: "Recording with eyes open" },
      { key: "eeg_cognitive_task", label: "Recording during performance of a cognitively responsive task" },
      { key: "eeg_conclusion", label: "Conclusion" },
    ],
  },
  {
    fields: [{ key: "prognostic_estimation", label: "Prognostic Estimation" }],
  },
];
const FIELD_KEYS = GROUPS.flatMap((g) => g.fields.map((f) => f.key));

const emptyForm = () => Object.fromEntries(FIELD_KEYS.map((k) => [k, ""]));
const fromApi = (c) => Object.fromEntries(FIELD_KEYS.map((k) => [k, c?.[k] || ""]));

async function errorMessage(res, fallback) {
  try {
    const body = await res.json();
    if (body?.error) return body.error;
  } catch {}
  return fallback;
}

/**
 * Technician's post-session commentary, which the PDF report requires. Loads the
 * session's draft if there is one, otherwise the published version (so it can be
 * revised), otherwise a blank form. `onPublished` fires after each successful publish.
 */
export default function SessionCommentary({ sessionId, onPublished }) {
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [active, setActive] = useState(null); // published version { version }, if any
  const [hasDraft, setHasDraft] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const [draftRes, activeRes] = await Promise.all([
          getSessionCommentaryDraft(sessionId),
          getSessionActiveCommentary(sessionId),
        ]);
        if (cancelled) return;
        for (const r of [draftRes, activeRes])
          if (!r.ok && r.status !== 404) throw new Error(String(r.status));
        const draft = draftRes.ok ? await draftRes.json() : null;
        const published = activeRes.ok ? await activeRes.json() : null;
        if (cancelled) return;
        setActive(published);
        setHasDraft(Boolean(draft));
        setForm(fromApi(draft || published));
      } catch {
        if (!cancelled) setLoadError("Couldn't load the commentary.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const change = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  };

  const missing = FIELD_KEYS.filter((k) => !form[k].trim());

  const saveDraft = async ({ quiet = false } = {}) => {
    const res = await saveSessionCommentaryDraft(sessionId, form);
    if (!res.ok) {
      toast.error(await errorMessage(res, "Failed to save the draft."), { duration: 8000 });
      return false;
    }
    setHasDraft(true);
    setDirty(false);
    if (!quiet) toast.success("Draft saved.");
    return true;
  };

  const handleSave = async () => {
    setBusy(true);
    try {
      await saveDraft();
    } catch {
      toast.error("Network error while saving.");
    } finally {
      setBusy(false);
    }
  };

  // Publishing saves the current text first so what's on screen is what gets published.
  const handlePublish = async () => {
    if (missing.length > 0) {
      toast.error("Fill in every section before publishing.");
      return;
    }
    setBusy(true);
    try {
      if (!(await saveDraft({ quiet: true }))) return;
      const res = await publishSessionCommentaryDraft(sessionId);
      if (!res.ok) {
        toast.error(await errorMessage(res, "Failed to publish."), { duration: 8000 });
        return;
      }
      const published = await res.json();
      setActive(published);
      setHasDraft(false);
      setDirty(false);
      toast.success("Commentary published.");
      onPublished?.(published);
    } catch {
      toast.error("Network error while publishing.");
    } finally {
      setBusy(false);
    }
  };

  let statusPill = <Pill tone="warn">Not published</Pill>;
  if (active && (dirty || hasDraft)) statusPill = <Pill tone="accent">Unpublished changes · v{active.version} live</Pill>;
  else if (active) statusPill = <Pill tone="good">Published · v{active.version}</Pill>;
  else if (hasDraft || dirty) statusPill = <Pill tone="neutral">Draft</Pill>;

  return (
    <Card>
      <CardHeader
        title="Session commentary"
        subtitle="Written by the technician after the session. Required before the PDF report can be generated, and printed in it."
        actions={statusPill}
      />
      {loading ? (
        <div className="p-10 flex items-center justify-center text-muted font-medium">
          <Spinner size={18} className="mr-2" /> Loading commentary…
        </div>
      ) : loadError ? (
        <p className="p-6 text-crit-strong font-medium">{loadError}</p>
      ) : (
        <div className="p-6 space-y-6">
          {GROUPS.map((g, i) => (
            <div key={g.title || i} className="space-y-4">
              {g.title && (
                <h3 className="text-[15px] font-semibold text-ink border-b border-border pb-2">{g.title}</h3>
              )}
              {g.fields.map((f) => (
                <Field key={f.key} label={f.label} required htmlFor={`commentary-${f.key}`}>
                  <Textarea
                    id={`commentary-${f.key}`}
                    rows={4}
                    value={form[f.key]}
                    onChange={(e) => change(f.key, e.target.value)}
                  />
                </Field>
              ))}
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-end gap-3">
            {missing.length > 0 && (
              <span className="text-[12px] text-muted mr-auto">
                {missing.length} of {FIELD_KEYS.length} sections still empty
              </span>
            )}
            <Button variant="subtle" onClick={handleSave} disabled={busy || !dirty}>
              Save draft
            </Button>
            <Button onClick={handlePublish} loading={busy} disabled={busy || missing.length > 0 || (!dirty && !hasDraft && Boolean(active))}>
              {active ? "Publish new version" : "Publish"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
