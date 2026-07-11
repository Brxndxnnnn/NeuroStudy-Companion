"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { fetchWithAuth } from "@/utils/api";
import { SessionTopBar } from "@/components/TopNav";
import { Card, CardHeader, Button, Spinner, Alert } from "@/components/ui";

const BANDS = [
  { key: "alpha", name: "Alpha (relaxation)", color: "var(--ch-fp1)" },
  { key: "beta", name: "Beta (focus)", color: "var(--ch-fp2)" },
  { key: "theta", name: "Theta (drowsy)", color: "var(--ch-t3)" },
  { key: "gamma", name: "Gamma (cognitive)", color: "var(--ch-t4)" },
];

export default function SessionResults() {
  const router = useRouter();
  const [eegData, setEegData] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [patientName, setPatientName] = useState("Unknown patient");

  useEffect(() => {
    const fetchResults = async () => {
      const sessionId = localStorage.getItem("currentSessionId");
      setPatientName(localStorage.getItem("currentClientName") || "Unknown patient");

      if (!sessionId) {
        setError("No active session found. Please select a patient from the dashboard.");
        setIsLoading(false);
        return;
      }

      try {
        const res = await fetchWithAuth(`http://139.59.126.77/api/sessions/${sessionId}/results`);
        if (res.ok) {
          const data = await res.json();
          setEegData(Array.isArray(data) ? data : data.results || []);
        } else {
          setError("Failed to load EEG data from the database.");
        }
      } catch (err) {
        setError("Network error while attempting to fetch results.");
      } finally {
        setIsLoading(false);
      }
    };
    fetchResults();
  }, [router]);

  return (
    <main className="min-h-screen bg-ground flex flex-col">
      <SessionTopBar
        onBack={() => router.push("/history")}
        backLabel="Dashboard"
        patient={patientName}
        right={<Button variant="ghost" size="sm" onClick={() => router.push("/history")}>Done</Button>}
      />

      <div className="max-w-6xl mx-auto w-full px-5 sm:px-8 py-8">
        <Card className="overflow-hidden">
          <CardHeader
            title="Session results"
            subtitle="Brainwave frequencies (band power) over the recording."
          />
          <div className="p-6">
            {isLoading ? (
              <div className="h-96 flex flex-col items-center justify-center gap-3 text-muted">
                <Spinner size={28} className="text-accent" />
                <span className="font-medium">Loading EEG visualizations…</span>
              </div>
            ) : error ? (
              <div className="h-96 flex items-center justify-center">
                <Alert tone="crit">{error}</Alert>
              </div>
            ) : eegData.length === 0 ? (
              <div className="h-96 flex items-center justify-center text-muted font-medium">
                No data points were recorded for this session.
              </div>
            ) : (
              <div className="h-[480px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={eegData} margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                    <XAxis
                      dataKey="timestamp"
                      stroke="var(--muted)"
                      fontSize={12}
                      tickFormatter={(tick) => new Date(tick).toLocaleTimeString()}
                    />
                    <YAxis stroke="var(--muted)" fontSize={12} />
                    <Tooltip
                      contentStyle={{
                        borderRadius: "12px",
                        border: "1px solid var(--border)",
                        background: "var(--surface)",
                        boxShadow: "0 8px 24px rgba(13,28,37,.12)",
                        color: "var(--ink)",
                      }}
                      labelFormatter={(label) => new Date(label).toLocaleTimeString()}
                    />
                    <Legend iconType="circle" wrapperStyle={{ paddingTop: "20px", fontSize: "13px" }} />
                    {BANDS.map((b) => (
                      <Line key={b.key} type="monotone" dataKey={b.key} stroke={b.color} strokeWidth={2} dot={false} name={b.name} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </Card>

        <p className="text-[12px] text-muted mt-4 text-center">
          A richer, zoomable results view with per-window statistics is in development.
        </p>
      </div>
    </main>
  );
}
