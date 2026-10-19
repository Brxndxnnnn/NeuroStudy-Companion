"use client";
import { Field, Input, Select, Textarea } from "@/components/ui";

// Mirrors backend/src/validators/clientHistory.validators.js — every field below is
// required to register a client or publish a history (only the per-item comments and
// notes are optional).
export const HISTORY_TEXT_FIELDS = [
  { key: "medical_history", label: "Medical history", hint: "Illnesses, surgeries, rehabilitation, relevant family history." },
  { key: "cognitive_behavioural_profile", label: "Cognitive and behavioural profile" },
  { key: "language_communication", label: "Language and communication", hint: "Handedness, languages, speech." },
  { key: "social_observations", label: "Social observations" },
  { key: "treatment_goals", label: "Treatment goals" },
  { key: "school_education", label: "School / education" },
  { key: "occupation", label: "Occupation", hint: "Enter “-” if not applicable." },
  { key: "hobbies", label: "Hobbies and interests" },
];

export const COMPLAINTS = [
  { key: "headache", label: "Headache" },
  { key: "medication", label: "Medication" },
  { key: "sleep_quality", label: "Sleep quality" },
  { key: "concentration", label: "Concentration" },
  { key: "motor_activity", label: "Motor activity" },
  { key: "pain", label: "Pain" },
];

export const SEVERITIES = [
  { value: "not_affected", label: "Not affected" },
  { value: "little_affected", label: "Little affected" },
  { value: "strongly_affected", label: "Strongly affected" },
];

export const SYMPTOMS = [
  { key: "concentration", label: "Concentration" },
  { key: "motivation", label: "Motivation" },
  { key: "social_skills", label: "Social skills" },
];

const today = () => new Date().toISOString().slice(0, 10);

export function emptyHistory() {
  const h = { intake_date: today() };
  for (const f of HISTORY_TEXT_FIELDS) h[f.key] = "";
  h.complaints = Object.fromEntries(COMPLAINTS.map((c) => [c.key, { severity: "", comment: "" }]));
  h.symptoms = Object.fromEntries(SYMPTOMS.map((s) => [s.key, { rating: "", notes: "" }]));
  return h;
}

// API history (arrays) → form state (objects keyed by name, inputs as strings).
export function historyFromApi(api) {
  const h = emptyHistory();
  if (!api) return h;
  h.intake_date = (api.intake_date || "").slice(0, 10) || h.intake_date;
  for (const f of HISTORY_TEXT_FIELDS) h[f.key] = api[f.key] || "";
  for (const c of api.complaints || [])
    if (h.complaints[c.complaint]) h.complaints[c.complaint] = { severity: c.severity, comment: c.comment || "" };
  for (const s of api.symptoms || [])
    if (h.symptoms[s.symptom]) h.symptoms[s.symptom] = { rating: String(s.rating), notes: s.notes || "" };
  return h;
}

// Form state → request body. Unanswered complaints/symptoms are omitted so the backend
// reports exactly which are missing.
export function historyToPayload(h) {
  const body = { intake_date: h.intake_date };
  for (const f of HISTORY_TEXT_FIELDS) body[f.key] = h[f.key];
  body.complaints = COMPLAINTS.filter((c) => h.complaints[c.key].severity).map((c) => ({
    complaint: c.key,
    severity: h.complaints[c.key].severity,
    comment: h.complaints[c.key].comment,
  }));
  body.symptoms = SYMPTOMS.filter((s) => h.symptoms[s.key].rating !== "").map((s) => ({
    symptom: s.key,
    rating: Number(h.symptoms[s.key].rating),
    notes: h.symptoms[s.key].notes,
  }));
  return body;
}

function Section({ title, subtitle, children }) {
  return (
    <section className="space-y-4">
      <div className="border-b border-border pb-2">
        <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
        {subtitle && <p className="text-[12px] text-muted mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

// Controlled: `value` is emptyHistory()-shaped, `onChange` receives the next value.
export default function ClientHistoryForm({ value, onChange, idPrefix = "h" }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const setComplaint = (key, patch) =>
    onChange({ ...value, complaints: { ...value.complaints, [key]: { ...value.complaints[key], ...patch } } });
  const setSymptom = (key, patch) =>
    onChange({ ...value, symptoms: { ...value.symptoms, [key]: { ...value.symptoms[key], ...patch } } });

  return (
    <div className="space-y-8">
      <Section title="Intake" subtitle="Date the questionnaire was completed.">
        <Field label="Intake date" required htmlFor={`${idPrefix}-intake`} className="md:w-1/2">
          <Input
            id={`${idPrefix}-intake`}
            type="date"
            value={value.intake_date}
            onChange={(e) => set({ intake_date: e.target.value })}
            required
          />
        </Field>
      </Section>

      <Section title="Background">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {HISTORY_TEXT_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint} required htmlFor={`${idPrefix}-${f.key}`}>
              <Textarea
                id={`${idPrefix}-${f.key}`}
                rows={3}
                value={value[f.key]}
                onChange={(e) => set({ [f.key]: e.target.value })}
                required
              />
            </Field>
          ))}
        </div>
      </Section>

      <Section title="Complaints in the last 4 weeks" subtitle="How much has each area been affected?">
        <div className="space-y-3">
          {COMPLAINTS.map((c) => (
            <div key={c.key} className="grid grid-cols-1 md:grid-cols-[10rem_12rem_1fr] gap-3 items-start">
              <div className="text-sm font-semibold text-ink md:pt-3">{c.label}</div>
              <Select
                aria-label={`${c.label} severity`}
                value={value.complaints[c.key].severity}
                onChange={(e) => setComplaint(c.key, { severity: e.target.value })}
                required
              >
                <option value="">Select…</option>
                {SEVERITIES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </Select>
              <Input
                aria-label={`${c.label} comment`}
                type="text"
                placeholder="Comment (optional)"
                value={value.complaints[c.key].comment}
                onChange={(e) => setComplaint(c.key, { comment: e.target.value })}
              />
            </div>
          ))}
        </div>
      </Section>

      <Section title="Symptom ratings" subtitle="Rate from 1 to 10.">
        <div className="space-y-3">
          {SYMPTOMS.map((s) => (
            <div key={s.key} className="grid grid-cols-1 md:grid-cols-[10rem_12rem_1fr] gap-3 items-start">
              <div className="text-sm font-semibold text-ink md:pt-3">{s.label}</div>
              <Input
                aria-label={`${s.label} rating`}
                type="number"
                min={1}
                max={10}
                step={1}
                placeholder="1–10"
                value={value.symptoms[s.key].rating}
                onChange={(e) => setSymptom(s.key, { rating: e.target.value })}
                required
              />
              <Input
                aria-label={`${s.label} notes`}
                type="text"
                placeholder="Notes (optional)"
                value={value.symptoms[s.key].notes}
                onChange={(e) => setSymptom(s.key, { notes: e.target.value })}
              />
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
