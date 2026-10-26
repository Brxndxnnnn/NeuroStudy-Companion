"use client";

import { useEffect, useState } from "react";
import { getMlGroupFit, getPhase1Eligibility } from "@/utils/api";
import { Alert, Button, Spinner } from "@/components/ui";
import { SearchInput, byName, matchesSearch } from "@/components/listTools";

// Compare a client outside a group with it (26 Oct 2026): personality (BFI-2), EEG profile
// (frequency-band shares) and response (the group's model scored on them). Each result is
// placed in the range of the members' own scores. Descriptive only, so the wording stays
// neutral: "within / outside the group's range", never "fits" or "does not fit".

const DOMAIN_NAMES = {
  E: "Extraversion",
  A: "Agreeableness",
  C: "Conscientiousness",
  N: "Negative emotionality",
  O: "Open-mindedness",
};

const fmt = (n, d = 2) => (n == null || Number.isNaN(n) ? "—" : Number(n).toFixed(d));
const signed = (n, d = 1) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${Number(n).toFixed(d)}`);

/* One sentence placing the client among the members. `further` names what a larger score
   means for this comparison ("further from the group" / "a larger error"). */
export function placementText(p, { closer, further }) {
  if (!p) return "";
  const { within_range, members_further, n_members } = p;
  const head = within_range ? "Within the group's range" : "Outside the group's range";
  const body = !within_range
    ? `${further} than every member`
    : members_further === 0
      ? "at the edge of the members' range"
      : `${closer} than ${members_further} of ${n_members} member${n_members === 1 ? "" : "s"}`;
  return `${head}: ${body}.`;
}

/* What a client can be compared on, from the eligibility list: personality needs a BFI-2,
   EEG profile and response need a usable session. With neither there is nothing to show. */
export function comparable(c) {
  const session = !!c.latest_session_id;
  const bfi = !!c.has_bfi;
  if (!session && !bfi) return { ok: false, note: "Nothing to compare yet: no usable session and no BFI-2." };
  if (!session) return { ok: true, note: "Personality only: no usable session yet." };
  if (!bfi) return { ok: true, note: "EEG profile and response only: no BFI-2 yet." };
  return { ok: true, note: null };
}

function Section({ title, question, result, closer, further, children }) {
  return (
    <section className="border-t border-border pt-4">
      <h4 className="text-[13px] font-semibold text-ink">{title}</h4>
      <p className="mt-0.5 text-[12px] text-muted">{question}</p>
      {!result?.available ? (
        <p className="mt-2 text-[12.5px] text-ink-2">Not available: {result?.reason ?? "no result."}</p>
      ) : (
        <>
          {result.placement ? (
            <Alert tone={result.placement.within_range ? "good" : "accent"} className="mt-3">
              {placementText(result.placement, { closer, further })}
              {result.placement.n_members < 3 && (
                <span className="mt-1 block font-normal">
                  The range comes from only {result.placement.n_members} members, so treat this as
                  a rough guide.
                </span>
              )}
            </Alert>
          ) : (
            <Alert tone="accent" className="mt-3">
              Not placed in a range: that needs at least 3 members, each compared with the others.
              The comparison with the group average is below.
            </Alert>
          )}
          <div className="mt-3">{children}</div>
        </>
      )}
    </section>
  );
}

function MemberRange({ members, value, label, field, digits = 2 }) {
  if (!members?.length) return null;
  return (
    <p className="mt-2 text-[12px] text-muted">
      {label}: this client <span className="font-mono tnum text-ink">{fmt(value, digits)}</span>
      {" · members "}
      {members.map((m, i) => (
        <span key={m.client_id}>
          {i > 0 && ", "}
          {m.client_name ?? "Unnamed"} <span className="font-mono tnum">{fmt(m[field], digits)}</span>
        </span>
      ))}
    </p>
  );
}

function PersonalityDetail({ result }) {
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="text-left text-[11px] text-muted">
            <tr>
              <th className="py-1.5 pr-4 font-semibold">Domain</th>
              <th className="py-1.5 pr-4 text-right font-semibold">This client</th>
              <th className="py-1.5 pr-4 text-right font-semibold">Group average</th>
              <th className="py-1.5 text-right font-semibold">Difference</th>
            </tr>
          </thead>
          <tbody className="font-mono tnum">
            {result.domains.map((d) => (
              <tr key={d.domain} className="border-t border-border">
                <td className="py-1.5 pr-4 font-sans text-ink">{DOMAIN_NAMES[d.domain] ?? d.domain}</td>
                <td className="py-1.5 pr-4 text-right">{fmt(d.client)}</td>
                <td className="py-1.5 pr-4 text-right">
                  {fmt(d.group_mean)} <span className="text-muted">± {fmt(d.group_sd)}</span>
                </td>
                <td className="py-1.5 text-right">{signed(d.z)} spreads</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <MemberRange members={result.members} value={result.distance} label="Distance" field="distance" />
    </>
  );
}

function EegDetail({ result }) {
  const top = [...result.features].sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 5);
  return (
    <>
      <p className="text-[12px] text-muted">
        Each channel&apos;s power split across the frequency bands, over this client&apos;s latest
        session. The five biggest differences from the group:
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="text-left text-[11px] text-muted">
            <tr>
              <th className="py-1.5 pr-4 font-semibold">Channel · band</th>
              <th className="py-1.5 pr-4 text-right font-semibold">This client</th>
              <th className="py-1.5 pr-4 text-right font-semibold">Group average</th>
              <th className="py-1.5 text-right font-semibold">Difference</th>
            </tr>
          </thead>
          <tbody className="font-mono tnum">
            {top.map((f) => (
              <tr key={`${f.channel}-${f.band}`} className="border-t border-border">
                <td className="py-1.5 pr-4 font-sans text-ink">
                  {f.channel} · {f.band}
                </td>
                <td className="py-1.5 pr-4 text-right">{fmt(f.client, 1)}%</td>
                <td className="py-1.5 pr-4 text-right">
                  {fmt(f.group_mean, 1)}% <span className="text-muted">± {fmt(f.group_sd, 1)}</span>
                </td>
                <td className="py-1.5 text-right">{signed(f.z)} spreads</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <MemberRange members={result.members} value={result.distance} label="Distance" field="distance" />
      <p className="mt-1 text-[12px] text-muted">
        The least reliable of the three while signal quality is still being checked: electrode
        contact and noise change these shares too.
      </p>
    </>
  );
}

function ResponseDetail({ result }) {
  return (
    <>
      <p className="text-[12px] text-muted">
        The group&apos;s model predicting this client&apos;s valence and arousal, tested the same
        way as each member was: trained without them, on images other than the ones it is
        tested on. Error is points off on the 1–7 scale, averaged over valence and arousal.
      </p>
      <p className="mt-2 text-[12.5px] text-ink-2">
        This client: valence error <span className="font-mono tnum">{fmt(result.mae.valence)}</span>,
        arousal error <span className="font-mono tnum">{fmt(result.mae.arousal)}</span> over{" "}
        {result.n_epochs} windows.
      </p>
      <MemberRange members={result.members} value={result.error} label="Error" field="error" />
    </>
  );
}

export default function MlGroupFit({ group }) {
  const memberIds = new Set((group.current_model?.members ?? []).map((m) => m.client_id));
  const [clients, setClients] = useState(null);
  const [clientId, setClientId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await getPhase1Eligibility();
        const data = await res.json().catch(() => ({}));
        if (!active) return;
        if (!res.ok) throw new Error(data.message || "Could not load clients.");
        setClients(data.clients || []);
      } catch (err) {
        if (active) {
          setClients([]);
          setError(err.message || "Could not load clients.");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const candidates = (clients ?? [])
    .filter((c) => !memberIds.has(c.client_id))
    .sort((a, b) => byName(a.client_name, b.client_name));
  const shown = candidates.filter((c) => matchesSearch(c.client_name || "Unnamed client", query));
  const chosen = candidates.find((c) => c.client_id === clientId);

  const compare = async () => {
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await getMlGroupFit(group.group_id, clientId);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || data.detail || "Could not compare this client.");
        return;
      }
      setResult(data);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-inset/30 p-4">
      <h3 className="text-[13px] font-semibold text-ink">Compare a client with this group</h3>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
        How someone outside the group compares with the people the model was trained on, in three
        ways. Each member is also compared with the rest of the group, and the client is placed
        in that range. This describes similarity only; it does not judge or predict anything
        about the client.
      </p>

      {clients === null ? (
        <div className="mt-3 flex items-center gap-2 text-muted">
          <Spinner size={14} />
          <span className="text-[13px]">Loading clients…</span>
        </div>
      ) : (
        <div className="mt-3 max-w-md">
          <SearchInput value={query} onChange={setQuery} label="Search clients to compare" />
          <div
            role="listbox"
            aria-label="Client to compare"
            className="mt-2 max-h-56 overflow-y-auto rounded-md border border-border bg-surface"
          >
            {shown.map((c) => {
              const missing = comparable(c);
              const on = c.client_id === clientId;
              return (
                <button
                  type="button"
                  key={c.client_id}
                  role="option"
                  aria-selected={on}
                  disabled={!missing.ok}
                  onClick={() => setClientId(c.client_id)}
                  className={`block w-full border-t border-border px-3 py-2 text-left text-[13px] first:border-t-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                    !missing.ok
                      ? "cursor-not-allowed text-muted"
                      : on
                        ? "cursor-pointer bg-accent-soft text-ink"
                        : "cursor-pointer text-ink hover:bg-inset/60"
                  }`}
                >
                  {c.client_name || "Unnamed client"}
                  {missing.note && <span className="block text-[11.5px] text-muted">{missing.note}</span>}
                </button>
              );
            })}
            {shown.length === 0 && (
              <p className="px-3 py-3 text-center text-[12.5px] text-muted">
                {candidates.length === 0
                  ? "Every client is already in this group."
                  : `No clients match “${query.trim()}”.`}
              </p>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button onClick={compare} loading={loading} disabled={!chosen || loading}>
              {loading ? "Comparing…" : chosen ? `Compare ${chosen.client_name || "client"}` : "Compare"}
            </Button>
          </div>
        </div>
      )}

      {loading && (
        <p className="mt-2 text-[12px] text-muted">
          Refitting the group&apos;s model to test it on this client. This can take a minute or two.
        </p>
      )}

      {error && <Alert tone="warn" className="mt-3">{error}</Alert>}

      {result && (
        <div className="mt-4 space-y-4">
          <p className="text-[12.5px] text-ink-2">
            <strong className="font-semibold text-ink">{result.client_name ?? "This client"}</strong>
            {result.session_start
              ? ` · latest usable session ${new Date(result.session_start).toLocaleDateString()}`
              : " · no usable session"}
            {` · compared with model v${result.model_version}`}
          </p>
          <Section
            title="Personality"
            question="Is their BFI-2 profile like the group's?"
            result={result.personality}
            closer="closer to the group"
            further="further from the group"
          >
            <PersonalityDetail result={result.personality} />
          </Section>
          <Section
            title="EEG profile"
            question="Does their brain activity look like the group's?"
            result={result.eeg_profile}
            closer="closer to the group"
            further="further from the group"
          >
            <EegDetail result={result.eeg_profile} />
          </Section>
          <Section
            title="Response"
            question="Does the group's link between EEG and emotion ratings hold for them?"
            result={result.response}
            closer="a smaller error"
            further="a larger error"
          >
            <ResponseDetail result={result.response} />
          </Section>
        </div>
      )}
    </div>
  );
}
