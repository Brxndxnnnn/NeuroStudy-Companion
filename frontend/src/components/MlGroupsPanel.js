"use client";

import { useEffect, useState } from "react";
import {
  getMlGroups,
  getPhase1Eligibility,
  createMlGroup,
  updateMlGroup,
  deleteMlGroup,
  trainMlGroup,
} from "@/utils/api";
import {
  Card,
  CardHeader,
  Field,
  Input,
  Pill,
  Alert,
  Spinner,
  Button,
} from "@/components/ui";
import MlGroupFit from "@/components/MlGroupFit";

// Group models (21 Oct 2026): the technician puts clients into a named group and trains
// one random-forest model on each member's latest labelled session, with the members'
// BFI-2 domain scores as extra inputs. Each model is scored by holding one person and
// their test images out, with and without BFI, against guessing the average.

export const fmt = (n, d = 2) => (n == null || Number.isNaN(n) ? "—" : Number(n).toFixed(d));

export function Metric({ label, value, hint, dir }) {
  return (
    <div>
      <div className="font-mono text-[10px] font-semibold tracking-[0.12em] uppercase text-muted">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-[19px] font-bold tracking-tight text-ink tnum">{value}</span>
        {dir && (
          <span className="text-[11px] font-medium text-muted whitespace-nowrap">
            {dir === "higher" ? "↑ better" : "↓ better"}
          </span>
        )}
      </div>
      {hint && <div className="mt-0.5 text-[12px] text-muted">{hint}</div>}
    </div>
  );
}

/* Plain-English verdict: does the model beat guessing the average (CV R² vs the
   predict-the-mean baseline), on both targets? */
export function modelVerdict(m) {
  if (!m) return null;
  const pairs = [
    [m.cv_r2_valence, m.null_r2_valence],
    [m.cv_r2_arousal, m.null_r2_arousal],
  ];
  if (pairs.some(([cv]) => cv == null)) return { tone: "neutral", text: "Not enough data to score this model yet." };
  const beaten = pairs.filter(([cv, nul]) => cv > (nul ?? -Infinity)).length;
  if (beaten === 2) return { tone: "good", text: "This model predicts better than simply guessing the average rating, on both valence and arousal." };
  if (beaten === 1) return { tone: "warn", text: "This model beats guess-the-average on one of the two measures only." };
  return { tone: "warn", text: "This model does not yet predict better than simply guessing the average rating." };
}

/* What adding the BFI inputs did, from the two cross-validated scores. A change under
   0.02 in R² is within the noise of a few people's data. */
export function bfiEffect(m) {
  if (m?.cv_r2_valence == null || m?.cv_r2_valence_no_bfi == null) return null;
  const dv = m.cv_r2_valence - m.cv_r2_valence_no_bfi;
  const da = m.cv_r2_arousal - m.cv_r2_arousal_no_bfi;
  const sign = (d) => `${d >= 0 ? "+" : ""}${d.toFixed(2)}`;
  const summary =
    Math.abs(dv) < 0.02 && Math.abs(da) < 0.02
      ? "no meaningful difference"
      : dv > 0 && da > 0
        ? "better on both measures"
        : dv < 0 && da < 0
          ? "worse on both measures"
          : "mixed";
  return { text: `${sign(dv)} valence, ${sign(da)} arousal`, summary };
}

function GroupModelMetrics({ model }) {
  const verdict = modelVerdict(model);
  const effect = bfiEffect(model);
  return (
    <div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        <Metric
          label="Evidence base"
          value={`${model.n_distinct_images ?? "—"} distinct ratings`}
          hint={`${model.n_clients ?? "—"} people · ${model.n_epochs ?? "—"} windows`}
        />
        <Metric label="Algorithm" value="Random forest" hint="EEG features + BFI-2 domains" />
        <Metric
          label="Trained"
          value={model.trained_at ? new Date(model.trained_at).toLocaleDateString() : "—"}
          hint={`Model version ${model.model_version}`}
        />
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-[13px] font-semibold text-ink">How accurate is it?</h4>
          <span className="text-[12px] text-muted">
            Tested on one person at a time, on images the model never saw
          </span>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="text-left text-[11px] text-muted">
              <tr>
                <th className="py-1.5 pr-4 font-semibold"></th>
                <th className="py-1.5 pr-4 text-right font-semibold">Valence accuracy ↑</th>
                <th className="py-1.5 pr-4 text-right font-semibold">Arousal accuracy ↑</th>
                <th className="py-1.5 pr-4 text-right font-semibold">Valence error ↓</th>
                <th className="py-1.5 text-right font-semibold">Arousal error ↓</th>
              </tr>
            </thead>
            <tbody className="font-mono tnum">
              <tr className="border-t border-border">
                <td className="py-1.5 pr-4 font-sans font-semibold text-ink">With BFI (in use)</td>
                <td className="py-1.5 pr-4 text-right">{fmt(model.cv_r2_valence)}</td>
                <td className="py-1.5 pr-4 text-right">{fmt(model.cv_r2_arousal)}</td>
                <td className="py-1.5 pr-4 text-right">{fmt(model.cv_mae_valence)}</td>
                <td className="py-1.5 text-right">{fmt(model.cv_mae_arousal)}</td>
              </tr>
              <tr className="border-t border-border text-ink-2">
                <td className="py-1.5 pr-4 font-sans">Without BFI</td>
                <td className="py-1.5 pr-4 text-right">{fmt(model.cv_r2_valence_no_bfi)}</td>
                <td className="py-1.5 pr-4 text-right">{fmt(model.cv_r2_arousal_no_bfi)}</td>
                <td className="py-1.5 pr-4 text-right">{fmt(model.cv_mae_valence_no_bfi)}</td>
                <td className="py-1.5 text-right">{fmt(model.cv_mae_arousal_no_bfi)}</td>
              </tr>
              <tr className="border-t border-border text-muted">
                <td className="py-1.5 pr-4 font-sans">Guessing the average</td>
                <td className="py-1.5 pr-4 text-right">{fmt(model.null_r2_valence)}</td>
                <td className="py-1.5 pr-4 text-right">{fmt(model.null_r2_arousal)}</td>
                <td className="py-1.5 pr-4 text-right">—</td>
                <td className="py-1.5 text-right">—</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[12px] text-muted">
          Accuracy is R²: 1.00 is perfect, 0.00 is no better than guessing the average, below
          zero is worse. Error is points off on the 1–7 scale.
        </p>
        {effect && (
          <p className="mt-2 text-[12.5px] text-ink-2">
            Adding BFI changed accuracy by <span className="font-mono tnum">{effect.text}</span>:{" "}
            <strong className="font-semibold text-ink">{effect.summary}</strong>.
          </p>
        )}
        {verdict && (
          <Alert tone={verdict.tone === "good" ? "good" : verdict.tone === "warn" ? "warn" : "accent"} className="mt-4">
            <span className="block">{verdict.text}</span>
            {verdict.tone !== "good" && (
              <span className="mt-1 block font-normal">
                Expected with only a few people and one set of images. It does not mean anything
                is broken; accuracy improves as more people are recorded over more OASIS images.
              </span>
            )}
          </Alert>
        )}
        {model.members?.length > 0 && <MemberScores members={model.members} />}
      </div>
    </div>
  );
}

/* Who the model was trained on and, for models trained since 26 Oct 2026, how well it
   served each member while they were the held-out person: the range a client compared
   with the group is placed in. */
function MemberScores({ members }) {
  const date = (m) => (m.start_time ? new Date(m.start_time).toLocaleDateString() : "—");
  if (!members.some((m) => m.cv_mae_valence != null)) {
    return (
      <p className="mt-3 text-[12px] text-muted">
        Trained on: {members.map((m) => `${m.client_name ?? "Unnamed"} (${date(m)})`).join(", ")}
      </p>
    );
  }
  return (
    <div className="mt-4">
      <h4 className="text-[13px] font-semibold text-ink">Each member, tested as if new</h4>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="text-left text-[11px] text-muted">
            <tr>
              <th className="py-1.5 pr-4 font-semibold">Member</th>
              <th className="py-1.5 pr-4 font-semibold">Session</th>
              <th className="py-1.5 pr-4 text-right font-semibold">Valence error ↓</th>
              <th className="py-1.5 text-right font-semibold">Arousal error ↓</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.client_id ?? m.session_id} className="border-t border-border">
                <td className="py-1.5 pr-4 text-ink">{m.client_name ?? "Unnamed"}</td>
                <td className="py-1.5 pr-4 text-ink-2">{date(m)}</td>
                <td className="py-1.5 pr-4 text-right font-mono tnum">{fmt(m.cv_mae_valence)}</td>
                <td className="py-1.5 text-right font-mono tnum">{fmt(m.cv_mae_arousal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GroupEditor({ initial, onSaved, onCancel }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [selected, setSelected] = useState(
    new Set((initial?.members ?? []).map((m) => m.client_id))
  );
  const [eligibility, setEligibility] = useState(null);
  const [minImages, setMinImages] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await getPhase1Eligibility();
        const data = await res.json().catch(() => ({}));
        if (!active) return;
        if (!res.ok) throw new Error(data.message || "Could not load clients.");
        setEligibility(data.clients || []);
        setMinImages(data.min_session_labelled_images ?? null);
      } catch (err) {
        if (active) {
          setEligibility([]);
          setError(err.message || "Could not load clients.");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const payload = { name: name.trim(), clientIds: [...selected] };
      const res = initial
        ? await updateMlGroup(initial.group_id, payload)
        : await createMlGroup(payload);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          res.status === 409
            ? "Another group in this clinic already has that name."
            : res.status === 403
              ? "You do not have permission to manage groups."
              : data.message || "Could not save the group."
        );
        return;
      }
      onSaved();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  };

  const reason = (c) =>
    !c.latest_session_id
      ? `no session with EEG and ${minImages ?? "enough"}+ labelled images`
      : !c.has_bfi
        ? "no complete BFI-2"
        : null;

  return (
    <div className="rounded-lg border border-border bg-inset/30 p-4">
      <h3 className="text-[13px] font-semibold text-ink">{initial ? `Edit “${initial.name}”` : "New group"}</h3>
      <Field label="Group name" className="mt-3 max-w-sm">
        <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pilot cohort" />
      </Field>

      <p className="mt-4 text-[13px] font-semibold text-ink">Members</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
        Training uses each member&apos;s latest session with labelled images, plus their BFI-2
        scores. Clients missing either can still be added; they are left out of training until
        they have both.
      </p>
      {eligibility === null ? (
        <div className="mt-3 flex items-center gap-2 text-muted">
          <Spinner size={14} />
          <span className="text-[13px]">Loading clients…</span>
        </div>
      ) : (
        <div className="mt-3 max-h-72 overflow-y-auto rounded-md border border-border bg-surface">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-surface text-left text-[11px] text-muted">
              <tr>
                <th className="w-8 px-3 py-2"></th>
                <th className="px-3 py-2 font-semibold">Client</th>
                <th className="px-3 py-2 font-semibold">Latest usable session</th>
                <th className="px-3 py-2 text-right font-semibold">Images</th>
                <th className="px-3 py-2 font-semibold">BFI-2</th>
              </tr>
            </thead>
            <tbody>
              {eligibility.map((c) => {
                const why = reason(c);
                return (
                  <tr key={c.client_id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Include ${c.client_name}`}
                        className="accent-[var(--accent)]"
                        checked={selected.has(c.client_id)}
                        onChange={() => toggle(c.client_id)}
                      />
                    </td>
                    <td className="px-3 py-2 text-ink">
                      {c.client_name || "Unnamed client"}
                      {why && <span className="block text-[11.5px] text-warn-strong">Won&apos;t train: {why}</span>}
                    </td>
                    <td className="px-3 py-2 text-ink-2">
                      {c.latest_session_at ? new Date(c.latest_session_at).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tnum text-ink-2">{c.n_labelled_images || "—"}</td>
                    <td className="px-3 py-2 text-ink-2">{c.has_bfi ? "✓" : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {error && <Alert tone="warn" className="mt-3">{error}</Alert>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button onClick={save} loading={saving} disabled={!name.trim() || selected.size === 0}>
          {initial ? "Save changes" : `Create group (${selected.size})`}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}

function TrainOutcome({ result }) {
  if (!result) return null;
  return (
    <Alert tone={result.trained ? "good" : "warn"} className="mt-3">
      <span className="block">{result.message}</span>
      {result.skipped?.length > 0 && (
        <span className="mt-1 block font-normal">
          Left out:{" "}
          {result.skipped.map((s) => `${s.client_name ?? "Unnamed"} (${s.reason})`).join("; ")}.
        </span>
      )}
    </Alert>
  );
}

export default function MlGroupsPanel({ onTrained }) {
  const [groups, setGroups] = useState(null);
  const [modelsAvailable, setModelsAvailable] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // null | "new" | group
  const [trainingId, setTrainingId] = useState(null);
  const [results, setResults] = useState({});
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [comparing, setComparing] = useState({});

  const load = async () => {
    setError("");
    try {
      const res = await getMlGroups();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `Could not load groups (${res.status}).`);
      setGroups(data.groups || []);
      setModelsAvailable(data.models_available !== false);
    } catch (err) {
      setGroups([]);
      setError(err.message || "Could not load groups.");
    }
  };

  useEffect(() => {
    load();
  }, []);

  const train = async (group) => {
    setTrainingId(group.group_id);
    setResults((r) => ({ ...r, [group.group_id]: null }));
    try {
      const res = await trainMlGroup(group.group_id);
      const data = await res.json().catch(() => ({}));
      const result = res.ok
        ? data
        : { trained: false, message: res.status === 403 ? "You do not have permission to train models." : data.message || data.detail || "Training failed." };
      setResults((r) => ({ ...r, [group.group_id]: result }));
      if (result.trained) {
        setExpanded((e) => ({ ...e, [group.group_id]: true }));
        await load();
        onTrained?.();
      }
    } catch {
      setResults((r) => ({ ...r, [group.group_id]: { trained: false, message: "Could not reach the server." } }));
    } finally {
      setTrainingId(null);
    }
  };

  const remove = async (group) => {
    try {
      const res = await deleteMlGroup(group.group_id);
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => ({}));
        setError(data.message || "Could not delete the group.");
        return;
      }
      setConfirmDelete(null);
      await load();
      onTrained?.();
    } catch {
      setError("Could not reach the server.");
    }
  };

  return (
    <Card>
      <CardHeader
        title="Group models"
        subtitle="Pool several clients' latest sessions into one model, with their BFI-2 personality scores as extra inputs."
        actions={
          editing === null && (
            <Button variant="ghost" size="sm" onClick={() => setEditing("new")}>
              New group
            </Button>
          )
        }
      />
      <div className="px-6 py-5 space-y-4">
        {error && <Alert tone="warn">{error}</Alert>}
        {!modelsAvailable && (
          <Alert tone="warn">The ML service is unreachable, so model scores are not shown right now.</Alert>
        )}

        {editing !== null && (
          <GroupEditor
            initial={editing === "new" ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await load();
            }}
          />
        )}

        {groups === null ? (
          <div className="flex items-center gap-2 text-muted">
            <Spinner size={14} />
            <span className="text-[13px]">Loading groups…</span>
          </div>
        ) : groups.length === 0 ? (
          editing === null && (
            <p className="text-sm text-muted">
              No groups yet. Create one, add clients, then train it to see predicted valence and
              arousal for their sessions.
            </p>
          )
        ) : (
          groups.map((g) => {
            const model = g.current_model;
            const busy = trainingId === g.group_id;
            const open = !!expanded[g.group_id];
            const comparingOpen = !!comparing[g.group_id];
            return (
              <section key={g.group_id} className="rounded-lg border border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-[14px] font-semibold text-ink">{g.name}</h3>
                    <p className="mt-0.5 text-[12.5px] text-muted">
                      {g.members.length} member{g.members.length === 1 ? "" : "s"}:{" "}
                      {g.members.map((m) => m.client_name || "Unnamed").join(", ")}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {model ? (
                      <Pill tone="good" dot>Trained · v{model.model_version}</Pill>
                    ) : (
                      <Pill tone="warn" dot>Not trained</Pill>
                    )}
                    <Button size="sm" onClick={() => train(g)} loading={busy} disabled={trainingId !== null}>
                      {busy ? "Training…" : model ? "Retrain" : "Train"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(g)} disabled={busy}>
                      Edit
                    </Button>
                    {confirmDelete === g.group_id ? (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => remove(g)}>
                          Confirm delete
                        </Button>
                        <Button size="sm" variant="subtle" onClick={() => setConfirmDelete(null)}>
                          Keep
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="subtle" onClick={() => setConfirmDelete(g.group_id)} disabled={busy}>
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
                {confirmDelete === g.group_id && (
                  <p className="mt-2 text-[12.5px] text-warn-strong">
                    Deleting removes this group&apos;s models and every prediction they made.
                  </p>
                )}

                <TrainOutcome result={results[g.group_id]} />

                {model && (
                  <div className="mt-3">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="subtle"
                        aria-expanded={open}
                        onClick={() => setExpanded((e) => ({ ...e, [g.group_id]: !open }))}
                      >
                        {open ? "Hide model details" : "Show model details"}
                      </Button>
                      <Button
                        size="sm"
                        variant="subtle"
                        aria-expanded={comparingOpen}
                        onClick={() => setComparing((c) => ({ ...c, [g.group_id]: !comparingOpen }))}
                      >
                        {comparingOpen ? "Hide comparison" : "Compare a client"}
                      </Button>
                    </div>
                    {open && (
                      <div className="mt-4">
                        <GroupModelMetrics model={model} />
                      </div>
                    )}
                    {comparingOpen && (
                      <div className="mt-4">
                        <MlGroupFit key={model.model_version} group={g} />
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>
    </Card>
  );
}
