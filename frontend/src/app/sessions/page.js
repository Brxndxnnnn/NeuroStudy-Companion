"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getSessions } from "@/utils/api";
import TopNav from "@/components/TopNav";
import {
  PageContainer,
  PageHeading,
  Card,
  CardHeader,
  Button,
  Input,
  Select,
  Pill,
  StatCard,
  Spinner,
} from "@/components/ui";

const STATUS_TONE = {
  completed: "good",
  recording: "crit",
  claimed: "accent",
  unclaimed: "neutral",
};

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

// Results need a closed recording window — anything still open has no waveform
// to plot, so the action is disabled rather than leading to an error screen.
function hasResults(s) {
  return Boolean(s.start_time && s.end_time);
}

function fmtWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(start, end) {
  if (!start || !end) return "—";
  const sec = (new Date(end) - new Date(start)) / 1000;
  if (!sec || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function SessionsPage() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [page, setPage] = useState(1);
  // The last response, tagged with the query it answers. Search, status filtering and
  // paging all happen in the backend (GET /api/sessions), so every session in the
  // clinic is reachable, not just the first page.
  const [result, setResult] = useState({ key: null, sessions: [], pagination: null, statusCounts: {}, error: "" });

  // Query the backend once typing pauses, not on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const queryKey = JSON.stringify([debouncedSearch, filterStatus, page]);

  useEffect(() => {
    const key = JSON.stringify([debouncedSearch, filterStatus, page]);
    // Responses can arrive out of order while typing; only the latest query's is kept.
    let cancelled = false;
    (async () => {
      try {
        const res = await getSessions({ search: debouncedSearch, sync_status: filterStatus, page, page_size: PAGE_SIZE });
        if (!res.ok) throw new Error("fetch");
        const data = await res.json();
        if (!cancelled)
          setResult({
            key,
            sessions: data.sessions || [],
            pagination: data.pagination || null,
            statusCounts: data.status_counts || {},
            error: "",
          });
      } catch {
        if (!cancelled)
          setResult((prev) => ({ ...prev, key, sessions: [], error: "Failed to load sessions from the database." }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, filterStatus, page]);

  const isLoading = result.key !== queryKey;
  const { sessions, pagination, statusCounts, error } = result;
  const totalSessions = pagination?.total ?? 0;
  const totalPages = pagination?.total_pages ?? 1;
  const hasFilters = Boolean(debouncedSearch || filterStatus);
  // Counted by the backend across every matching session, not just this page.
  const completedCount = statusCounts.completed ?? 0;

  const openResults = (sessionId, clientName) => {
    // Keep the "current session" pointers in step so the results page reads the
    // same session whether it was opened from here or straight after recording.
    localStorage.setItem("currentSessionId", sessionId);
    if (clientName) localStorage.setItem("currentClientName", clientName);
    router.push(`/session/result?session_id=${sessionId}`);
  };

  return (
    <main className="min-h-screen bg-ground">
      <TopNav />

      <PageContainer width="wide" className="py-8 space-y-7">
        <PageHeading
          title="Sessions"
          subtitle="Every recorded session. Open a completed one to review its EEG, bands and vitals."
        />

        <div className="grid grid-cols-2 gap-4">
          <StatCard
            label={hasFilters ? "Matching sessions" : "Total sessions"}
            value={isLoading ? "—" : totalSessions}
            hint={hasFilters ? "filtered view" : "all sessions"}
          />
          <StatCard
            label="Completed"
            value={isLoading ? "—" : completedCount}
            hint={hasFilters ? "in this filtered view" : "recording finished"}
          />
        </div>

        <Card className="overflow-hidden">
          <CardHeader title="Session history" subtitle="Most recent first." />

          <div className="flex flex-col sm:flex-row gap-3 px-6 py-4 bg-inset/40 border-b border-border">
            <div className="relative w-full sm:flex-1">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <Input
                type="text"
                placeholder="Search by patient, technician or session ID…"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                className="pl-10 py-2.5 text-sm"
              />
            </div>
            <Select
              value={filterStatus}
              onChange={(e) => {
                setFilterStatus(e.target.value);
                setPage(1);
              }}
              className="w-full sm:w-44 py-2.5 text-sm"
            >
              <option value="">All statuses</option>
              <option value="completed">Completed</option>
              <option value="recording">Recording</option>
              <option value="claimed">Claimed</option>
              <option value="unclaimed">Unclaimed</option>
            </Select>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left min-w-[720px]">
              <thead>
                <tr className="border-b border-border">
                  {["Patient", "Recorded", "Duration", "Status", "Action"].map((h, i) => (
                    <th
                      key={h}
                      className={`px-6 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted font-semibold ${
                        i === 4 ? "text-right" : ""
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan="5" className="px-6 py-12 text-center text-muted font-medium">
                      <Spinner size={18} className="mr-2 align-[-3px]" />
                      Loading sessions…
                    </td>
                  </tr>
                ) : error ? (
                  <tr>
                    <td colSpan="5" className="px-6 py-12 text-center text-crit-strong font-medium">
                      {error}
                    </td>
                  </tr>
                ) : sessions.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="px-6 py-14 text-center">
                      <p className="text-muted font-medium mb-3">
                        {hasFilters
                          ? "No sessions match your filters."
                          : "No sessions have been recorded yet."}
                      </p>
                      {!hasFilters && (
                        <Button variant="subtle" size="sm" onClick={() => router.push("/history")}>
                          Start a session →
                        </Button>
                      )}
                    </td>
                  </tr>
                ) : (
                  sessions.map((s) => {
                    const ready = hasResults(s);
                    return (
                      <tr
                        key={s.session_id}
                        className="border-b border-border last:border-0 hover:bg-accent-soft/30 transition-colors"
                      >
                        <td className="px-6 py-4">
                          <div className="font-semibold text-ink">{s.client_name || "Unassigned"}</div>
                          <div className="font-mono text-[11px] text-muted mt-0.5">
                            {s.session_id?.slice(0, 8) || "—"}
                            {s.technician_name ? ` · ${s.technician_name}` : ""}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-ink-2 tnum">{fmtWhen(s.start_time)}</td>
                        <td className="px-6 py-4 text-sm text-ink-2 font-mono tnum">
                          {fmtDuration(s.start_time, s.end_time)}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Pill tone={STATUS_TONE[s.sync_status] || "neutral"}>{s.sync_status || "unknown"}</Pill>
                            {s.sync_status === "completed" && (
                              <Pill tone={s.has_active_commentary ? "good" : "warn"}>
                                {s.has_active_commentary ? "Commentary" : "No commentary"}
                              </Pill>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-right">
                          {ready ? (
                            <Button size="sm" onClick={() => openResults(s.session_id, s.client_name)}>
                              View results →
                            </Button>
                          ) : (
                            <span className="text-[12px] text-muted">No results yet</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {!isLoading && !error && totalSessions > 0 && (
            <div className="flex flex-col gap-3 border-t border-border px-6 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
              <span className="text-muted">
                Showing {(page - 1) * PAGE_SIZE + 1}–{(page - 1) * PAGE_SIZE + sessions.length} of {totalSessions} sessions
              </span>
              <div className="flex items-center gap-3">
                <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <span className="font-mono text-xs text-muted">
                  Page {page} of {totalPages}
                </span>
                <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </Card>
      </PageContainer>
    </main>
  );
}
