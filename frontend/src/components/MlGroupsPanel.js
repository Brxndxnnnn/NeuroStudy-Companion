"use client";

import { useEffect, useRef, useState } from "react";
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
  Select,
  Pill,
  Alert,
  Spinner,
  Button,
} from "@/components/ui";
import MlGroupFit from "@/components/MlGroupFit";
import { SearchInput, SortHeader, byName, matchesSearch, timeAgo, useSort } from "@/components/listTools";

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
  const { sorted, sort, toggle } = useSort(members, {
    name: (m) => m.client_name || "",
    session: (m) => (m.start_time ? new Date(m.start_time).getTime() : null),
    valence: (m) => m.cv_mae_valence,
    arousal: (m) => m.cv_mae_arousal,
  });
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
          <thead className="text-[11px] text-muted">
            <tr>
              <SortHeader label="Member" column="name" sort={sort} onSort={toggle} className="py-1.5 pr-4" />
              <SortHeader label="Session" column="session" sort={sort} onSort={toggle} className="py-1.5 pr-4" />
              <SortHeader label="Valence error" column="valence" sort={sort} onSort={toggle} align="right" className="py-1.5 pr-4" />
              <SortHeader label="Arousal error" column="arousal" sort={sort} onSort={toggle} align="right" className="py-1.5" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => (
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

// Has what training needs: a usable session and a complete BFI-2.
const canTrain = (c) => !!c.latest_session_id && !!c.has_bfi;

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

  const [query, setQuery] = useState("");
  const [readyOnly, setReadyOnly] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const { sorted, sort, toggle: sortBy } = useSort(eligibility, {
    name: (c) => c.client_name || "",
    session: (c) => (c.latest_session_at ? new Date(c.latest_session_at).getTime() : null),
    images: (c) => c.n_labelled_images || null,
    bfi: (c) => (c.has_bfi ? 1 : 0),
  });
  const shown = sorted.filter(
    (c) => matchesSearch(c.client_name || "Unnamed client", query) && (!readyOnly || canTrain(c))
  );

  // Unsaved changes: a different name or a different set of members from what was opened.
  const initialIds = new Set((initial?.members ?? []).map((m) => m.client_id));
  const dirty =
    name.trim() !== (initial?.name ?? "").trim() ||
    selected.size !== initialIds.size ||
    [...selected].some((id) => !initialIds.has(id));

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const selectShown = () => setSelected(new Set([...selected, ...shown.map((c) => c.client_id)]));

  // Selected clients, by name. A member the eligibility list does not return still shows,
  // under the name the group has for them.
  const nameOf = new Map((initial?.members ?? []).map((m) => [m.client_id, m.client_name]));
  for (const c of eligibility ?? []) nameOf.set(c.client_id, c.client_name);
  const chosen = [...selected]
    .map((id) => ({ id, name: nameOf.get(id) || "Unnamed client" }))
    .sort((a, b) => byName(a.name, b.name));
  const chosenRows = (eligibility ?? []).filter((c) => selected.has(c.client_id));
  const nReady = chosenRows.filter(canTrain).length;
  const nNotReady = selected.size - nReady;

  const cancel = () => (dirty ? setConfirmDiscard(true) : onCancel());

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
        <>
          {chosen.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Selected clients">
              {chosen.map((c) => (
                <li
                  key={c.id}
                  className="inline-flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-2.5 pr-1 text-[12px] text-ink"
                >
                  {c.name}
                  <button
                    type="button"
                    aria-label={`Remove ${c.name}`}
                    onClick={() => toggle(c.id)}
                    className="rounded-full px-1.5 leading-none text-muted hover:bg-surface hover:text-ink"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <SearchInput value={query} onChange={setQuery} label="Search clients" className="w-full max-w-xs" />
            <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-2">
              <input
                type="checkbox"
                className="accent-[var(--accent)]"
                checked={readyOnly}
                onChange={(e) => setReadyOnly(e.target.checked)}
              />
              Only clients ready to train
            </label>
            <div className="flex gap-1">
              <Button size="sm" variant="quiet" onClick={selectShown} disabled={shown.length === 0}>
                Select all shown ({shown.length})
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
                Clear selection
              </Button>
            </div>
          </div>

          <div className="mt-2 max-h-72 overflow-y-auto rounded-md border border-border bg-surface">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-surface text-[11px] text-muted">
                <tr>
                  <th className="w-8 px-3 py-2"><span className="sr-only">Include</span></th>
                  <SortHeader label="Client" column="name" sort={sort} onSort={sortBy} className="px-3 py-2" />
                  <SortHeader label="Latest usable session" column="session" sort={sort} onSort={sortBy} className="px-3 py-2" />
                  <SortHeader label="Images" column="images" sort={sort} onSort={sortBy} align="right" className="px-3 py-2" />
                  <SortHeader label="BFI-2" column="bfi" sort={sort} onSort={sortBy} className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => {
                  const why = reason(c);
                  const on = selected.has(c.client_id);
                  return (
                    <tr
                      key={c.client_id}
                      // The whole row ticks the box; the box itself handles its own clicks.
                      onClick={(e) => e.target.tagName !== "INPUT" && toggle(c.client_id)}
                      className={`cursor-pointer border-t border-border hover:bg-inset/60 ${on ? "bg-accent-soft/40" : ""}`}
                    >
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          aria-label={`Include ${c.client_name}`}
                          className="accent-[var(--accent)]"
                          checked={on}
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
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-4 text-center text-[12.5px] text-muted">
                      {eligibility.length === 0
                        ? "No clients yet."
                        : query
                          ? `No clients match “${query.trim()}”.`
                          : "No clients are ready to train yet."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {error && <Alert tone="warn" className="mt-3">{error}</Alert>}

      {selected.size > 0 && (
        <p className="mt-3 text-[12.5px] text-ink-2">
          {selected.size} selected · {nReady} will train
          {nNotReady > 0 && (
            <span className="text-warn-strong"> · {nNotReady} won&apos;t until they have a usable session and BFI-2</span>
          )}
        </p>
      )}

      {confirmDiscard ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-warn-strong">Discard your changes to this group?</span>
          <Button size="sm" variant="ghost" onClick={onCancel}>Discard</Button>
          <Button size="sm" variant="subtle" onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={save} loading={saving} disabled={!name.trim() || selected.size === 0}>
            {initial ? "Save changes" : `Create group (${selected.size})`}
          </Button>
          <Button variant="ghost" onClick={cancel} disabled={saving}>Cancel</Button>
        </div>
      )}
    </div>
  );
}

// Training runs in the background on the ML service (it takes minutes and grows with every
// member); its progress is saved on the group, so the page polls the group list while any
// group is training and shows the outcome even after a reload.
const POLL_MS = 4000;

export const isTraining = (g) => g.train_status === "running" && !g.train_stale;

const clock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—");
const when = (t) => (t ? `${new Date(t).toLocaleDateString()} ${clock(t)}` : "—");

function minutesSince(t) {
  const m = Math.floor((Date.now() - new Date(t).getTime()) / 60000);
  return m < 1 ? "less than a minute" : `${m} minute${m === 1 ? "" : "s"}`;
}

export function TrainStatus({ group }) {
  const { train_status: status, train_result: result, train_error: error } = group;
  if (isTraining(group)) {
    return (
      <Alert tone="accent" className="mt-3">
        <span className="flex items-center gap-2">
          <Spinner size={14} />
          Training… started at {clock(group.train_started_at)} ({minutesSince(group.train_started_at)} ago).
        </span>
        <span className="mt-1 block font-normal">
          Larger groups can take several minutes. It carries on in the background, so you can
          leave this page and come back.
        </span>
      </Alert>
    );
  }
  if (status === "running") {
    return (
      <Alert tone="warn" className="mt-3">
        Training started at {when(group.train_started_at)} and has not finished. The ML service may
        have restarted. Press Train to start again.
      </Alert>
    );
  }
  if (status === "failed") {
    return (
      <Alert tone="warn" className="mt-3">
        <span className="block">Training failed at {when(group.train_finished_at)}.</span>
        {error && <span className="mt-1 block font-normal">{error}</span>}
      </Alert>
    );
  }
  if (status === "done" && result) {
    return (
      <Alert tone={result.trained ? "good" : "warn"} className="mt-3">
        <span className="block">
          {result.message} <span className="font-normal">Finished {when(group.train_finished_at)}.</span>
        </span>
        {result.skipped?.length > 0 && (
          <span className="mt-1 block font-normal">
            Left out:{" "}
            {result.skipped.map((s) => `${s.client_name ?? "Unnamed"} (${s.reason})`).join("; ")}.
          </span>
        )}
      </Alert>
    );
  }
  return null;
}

const MEMBERS_SHOWN = 6;

/* "4 members: Ann, Ben, …", A→Z, folded to the first few with a toggle for the rest. */
function MemberNames({ members }) {
  const [all, setAll] = useState(false);
  const names = members.map((m) => m.client_name || "Unnamed").sort(byName);
  const hidden = names.length - MEMBERS_SHOWN;
  const list = all || hidden <= 0 ? names : names.slice(0, MEMBERS_SHOWN);
  return (
    <p className="mt-0.5 text-[12.5px] text-muted">
      {names.length} member{names.length === 1 ? "" : "s"}
      {names.length > 0 && ": "}
      {list.join(", ")}
      {hidden > 0 && (
        <>
          {!all && ` +${hidden} more`}{" "}
          <button
            type="button"
            onClick={() => setAll(!all)}
            className="font-semibold text-accent-strong hover:underline"
          >
            {all ? "Show fewer" : "Show all"}
          </button>
        </>
      )}
    </p>
  );
}

// Orders for the group list. "Newest" is the order the server sends.
const GROUP_SORTS = {
  newest: { label: "Newest first", compare: (a, b) => new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0) },
  name: { label: "Name (A–Z)", compare: (a, b) => byName(a.name, b.name) },
  trained: {
    label: "Last trained",
    compare: (a, b) =>
      new Date(b.current_model?.trained_at ?? 0) - new Date(a.current_model?.trained_at ?? 0),
  },
  members: { label: "Most members", compare: (a, b) => b.members.length - a.members.length },
};

export default function MlGroupsPanel({ onTrained }) {
  const [groups, setGroups] = useState(null);
  const [modelsAvailable, setModelsAvailable] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // null | "new" | group
  const [startingId, setStartingId] = useState(null);
  const [trainErrors, setTrainErrors] = useState({});
  const wasTraining = useRef(new Set());
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [comparing, setComparing] = useState({});
  const [groupQuery, setGroupQuery] = useState("");
  const [groupSort, setGroupSort] = useState("newest");

  // A group matches the search by its own name or any member's.
  const shownGroups = (groups ?? [])
    .filter(
      (g) =>
        matchesSearch(g.name, groupQuery) ||
        g.members.some((m) => matchesSearch(m.client_name, groupQuery))
    )
    .sort(GROUP_SORTS[groupSort].compare);

  // poll: a background refresh while training. A failed poll keeps what is on screen
  // and the next one tries again, rather than emptying the list and stopping the polling.
  const load = async ({ poll = false } = {}) => {
    if (!poll) setError("");
    try {
      const res = await getMlGroups();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `Could not load groups (${res.status}).`);
      setGroups(data.groups || []);
      setModelsAvailable(data.models_available !== false);
    } catch (err) {
      if (poll) return;
      setGroups([]);
      setError(err.message || "Could not load groups.");
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Poll while any group is training.
  const anyTraining = !!groups?.some(isTraining);
  useEffect(() => {
    if (!anyTraining) return undefined;
    const timer = setInterval(() => load({ poll: true }), POLL_MS);
    return () => clearInterval(timer);
  }, [anyTraining]);

  // A group that just finished training: open its new model and refresh the rest of the
  // Insights tab (session list, predictions).
  useEffect(() => {
    if (!groups) return;
    const finished = groups.filter(
      (g) => wasTraining.current.has(g.group_id) && !isTraining(g) && g.train_result?.trained
    );
    wasTraining.current = new Set(groups.filter(isTraining).map((g) => g.group_id));
    if (finished.length) {
      setExpanded((e) => ({ ...e, ...Object.fromEntries(finished.map((g) => [g.group_id, true])) }));
      onTrained?.();
    }
  }, [groups, onTrained]);

  // Starts training in the background. The request answers at once; progress then comes
  // from the group list, which is polled while the group is training.
  const train = async (group) => {
    setStartingId(group.group_id);
    setTrainErrors((r) => ({ ...r, [group.group_id]: "" }));
    try {
      const res = await trainMlGroup(group.group_id);
      if (!res.ok && res.status !== 409) {
        const data = await res.json().catch(() => ({}));
        setTrainErrors((r) => ({
          ...r,
          [group.group_id]:
            res.status === 403
              ? "You do not have permission to train models."
              : data.message || data.detail || "Could not start training.",
        }));
      }
      await load();
    } catch {
      setTrainErrors((r) => ({ ...r, [group.group_id]: "Could not reach the server." }));
    } finally {
      setStartingId(null);
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
          <>
            {groups.length > 1 && (
              <div className="flex flex-wrap items-center gap-2">
                <SearchInput
                  value={groupQuery}
                  onChange={setGroupQuery}
                  placeholder="Search groups or members"
                  className="w-full max-w-xs"
                />
                <Select
                  size="sm"
                  value={groupSort}
                  onChange={(e) => setGroupSort(e.target.value)}
                  aria-label="Sort groups"
                >
                  {Object.entries(GROUP_SORTS).map(([key, s]) => (
                    <option key={key} value={key}>{s.label}</option>
                  ))}
                </Select>
              </div>
            )}
            {shownGroups.length === 0 && (
              <p className="text-[12.5px] text-muted">No groups or members match “{groupQuery.trim()}”.</p>
            )}
            {shownGroups.map((g) => {
              const model = g.current_model;
              const training = isTraining(g);
              const busy = training || startingId === g.group_id;
              const open = !!expanded[g.group_id];
              const comparingOpen = !!comparing[g.group_id];
              return (
                <section key={g.group_id} className="rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-[14px] font-semibold text-ink">{g.name}</h3>
                      <MemberNames members={g.members} />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {training ? (
                        <Pill tone="accent" dot live>Training…</Pill>
                      ) : model ? (
                        <>
                          {model.trained_at && (
                            <span className="text-[12px] text-muted" title={`Trained ${when(model.trained_at)}`}>
                              {timeAgo(model.trained_at)}
                            </span>
                          )}
                          <Pill tone="good" dot>Trained · v{model.model_version}</Pill>
                        </>
                      ) : (
                        <Pill tone="warn" dot>Not trained</Pill>
                      )}
                      <Button size="sm" onClick={() => train(g)} loading={busy} disabled={busy}>
                        {training ? "Training…" : model ? "Retrain" : "Train"}
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

                  <TrainStatus group={g} />
                  {trainErrors[g.group_id] && (
                    <Alert tone="warn" className="mt-3">{trainErrors[g.group_id]}</Alert>
                  )}

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
            })}
          </>
        )}
      </div>
    </Card>
  );
}
