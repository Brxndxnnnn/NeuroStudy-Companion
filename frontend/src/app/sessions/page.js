"use client";
import { useState, useEffect, useMemo } from "react";
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
  const [sessions, setSessions] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const res = await getSessions();
        if (!res.ok) throw new Error("fetch");
        const data = await res.json();
        setSessions(Array.isArray(data) ? data : data.sessions || []);
      } catch (err) {
        setError("Failed to load sessions from the database.");
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, []);

  const filtered = useMemo(
    () =>
      sessions.filter((s) => {
        const q = searchQuery.toLowerCase();
        const matchesName = !q || (s.client_name || "").toLowerCase().includes(q);
        const matchesStatus = !filterStatus || s.sync_status === filterStatus;
        return matchesName && matchesStatus;
      }),
    [sessions, searchQuery, filterStatus]
  );

  const completedCount = useMemo(() => sessions.filter(hasResults).length, [sessions]);

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

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <StatCard label="Total sessions" value={isLoading ? "—" : sessions.length} />
          <StatCard
            label="With results"
            value={isLoading ? "—" : completedCount}
            hint="closed recording window"
          />
          <StatCard
            label="Matching filters"
            value={isLoading ? "—" : filtered.length}
            hint={searchQuery || filterStatus ? "filtered view" : "all sessions"}
            className="hidden sm:block"
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
                placeholder="Search by patient name…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 py-2.5 text-sm"
              />
            </div>
            <Select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
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
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="px-6 py-14 text-center">
                      <p className="text-muted font-medium mb-3">
                        {sessions.length === 0
                          ? "No sessions have been recorded yet."
                          : "No sessions match your filters."}
                      </p>
                      {sessions.length === 0 && (
                        <Button variant="subtle" size="sm" onClick={() => router.push("/history")}>
                          Start a session →
                        </Button>
                      )}
                    </td>
                  </tr>
                ) : (
                  filtered.map((s) => {
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
                          <Pill tone={STATUS_TONE[s.sync_status] || "neutral"}>{s.sync_status || "unknown"}</Pill>
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
        </Card>
      </PageContainer>
    </main>
  );
}
