"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { pairSession, logout } from "@/utils/api";
import { SessionTopBar } from "@/components/TopNav";
import { Button, Label, Alert } from "@/components/ui";

export default function SessionSetup() {
  const router = useRouter();
  const [pairingCode, setPairingCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [feedback, setFeedback] = useState({ type: "", message: "" });
  const [selectedClient, setSelectedClient] = useState({ id: "", name: "" });

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
      return;
    }
    const clientId = localStorage.getItem("currentClientId");
    const clientName = localStorage.getItem("currentClientName");
    if (!clientId) {
      router.push("/history");
    } else {
      setSelectedClient({ id: clientId, name: clientName });
    }
  }, [router]);

  const handleVerify = async (e) => {
    e.preventDefault();
    setFeedback({ type: "", message: "" });
    if (pairingCode.length !== 6) return;
    setIsLoading(true);

    try {
      const response = await pairSession(pairingCode, selectedClient.id);
      if (response.ok) {
        const data = await response.json();
        const session = data.session || data;
        localStorage.setItem("currentSessionId", session.session_id || session.id);
        if (session.stimulus_set_id) {
          localStorage.setItem("currentStimulusSetId", session.stimulus_set_id);
        } else {
          localStorage.removeItem("currentStimulusSetId");
        }
        setFeedback({ type: "success", message: "Paired successfully. Initializing…" });
        setTimeout(() => router.push("/session/active"), 1200);
      } else {
        setFeedback({ type: "error", message: "Invalid pairing code, or the session was already claimed." });
      }
    } catch (error) {
      setFeedback({ type: "error", message: "Network error while pairing. Please try again." });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="min-h-screen ns-aura flex flex-col">
      <SessionTopBar
        onBack={() => router.push("/history")}
        backLabel="Change client"
        right={
          <Button variant="quiet" size="sm" onClick={() => logout()}>
            Sign out
          </Button>
        }
      />

      <div className="flex-1 flex flex-col items-center justify-center px-5 py-12">
        <div className="text-center mb-8 anim-rise">
          <Label>EEG session setup</Label>
          <h1 className="text-3xl font-bold tracking-tight text-ink mt-3">Pair the headset</h1>
          <p className="text-muted mt-2">
            Pairing for patient{" "}
            <span className="font-semibold text-accent-strong bg-accent-soft px-2.5 py-1 rounded-lg">
              {selectedClient.name}
            </span>
          </p>
        </div>

        <div className="w-full max-w-md bg-surface border border-border rounded-2xl shadow-[0_8px_30px_rgba(13,28,37,.08)] p-8 anim-pop">
          <div className="text-center mb-6">
            <Label>Bridge pairing code</Label>
          </div>

          {feedback.message && (
            <Alert tone={feedback.type === "success" ? "good" : "crit"} className="mb-6 text-center">
              {feedback.message}
            </Alert>
          )}

          <form onSubmit={handleVerify} className="flex flex-col items-center">
            <input
              type="text"
              inputMode="text"
              maxLength="6"
              placeholder="C2E2AA"
              disabled={isLoading || feedback.type === "success"}
              value={pairingCode}
              onChange={(e) => setPairingCode(e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase())}
              className="w-64 text-center font-mono text-4xl font-bold tracking-[0.28em] py-5 rounded-2xl border-2 border-border-strong bg-inset text-ink uppercase transition-all mb-7
                         focus:outline-none focus:border-accent focus:bg-surface focus:ring-4 focus:ring-accent/15
                         placeholder:text-border-strong placeholder:font-medium placeholder:tracking-normal
                         disabled:opacity-60"
              aria-label="Bridge pairing code"
            />
            <Button
              type="submit"
              size="lg"
              fullWidth
              loading={isLoading}
              disabled={pairingCode.length !== 6}
            >
              Verify code &amp; continue
            </Button>
          </form>
        </div>

        <p className="text-[12px] text-muted mt-6 max-w-md text-center">
          The 6-character code is shown on the bridge PC once the headset connects.
        </p>
      </div>
    </main>
  );
}
