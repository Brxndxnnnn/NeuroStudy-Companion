"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { pairSession, logout } from "@/utils/api";


export default function SessionSetup() {
  const router = useRouter();
  const [pairingCode, setPairingCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [feedback, setFeedback] = useState({ type: "", message: "" });
  
  // Holds the client details selected from the dashboard
  const [selectedClient, setSelectedClient] = useState({ id: "", name: "" });

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
      return;
    }

    // Force user to pick a client first before pairing
    const clientId = localStorage.getItem("currentClientId");
    const clientName = localStorage.getItem("currentClientName");
    
    if (!clientId) {
      router.push("/history");
    } else {
      setSelectedClient({ id: clientId, name: clientName });
    }
  }, [router]);

  // STEP 1: CLAIM THE SESSION
  const handleVerify = async (e) => {
    e.preventDefault();
    setFeedback({ type: "", message: "" });
    if (pairingCode.length !== 6) return;
    setIsLoading(true);

    try {
      const response = await pairSession(pairingCode, selectedClient.id);

      if (response.ok) {
        const data = await response.json();
        localStorage.setItem("currentSessionId", data.session?.session_id || data.id);
        
        setFeedback({ type: "success", message: "Paired successfully! Initializing..." });
        setTimeout(() => router.push("/session/active"), 1500);
      } else {
        setFeedback({ type: "error", message: "Invalid pairing code or session already claimed." });
      }
    } catch (error) {
      setFeedback({ type: "error", message: "Error " });
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = async () => {
    const token = localStorage.getItem("token");
    
    //destroy the session
    if (token) {
      try {
        await logout();
      } catch (err) {
        console.error("Failed to notify server of logout", err);
      }
    }

    //2.Clear our local browser memory
    localStorage.removeItem("token");
    localStorage.removeItem("userRole");
    localStorage.removeItem("currentClientId");
    localStorage.removeItem("currentClientName");
    localStorage.removeItem("currentSessionId");
    // ... clear any other items
    
    // 3. Send user back to login screen
    router.push("/login");
  };

  return (
    <main className="min-h-screen bg-slate-50 p-8 font-sans flex flex-col items-center">
      
      {/* Top Navigation Bar */}
      <div className="w-full max-w-4xl flex justify-between items-center mb-16 bg-white p-4 rounded-xl shadow-sm border border-slate-200">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold">NS</div>
          <span className="font-bold text-slate-800 text-lg tracking-tight">NeuroStudy</span>
        </div>
        <div className="flex items-center gap-4">
          <button 
            onClick={() => router.push("/history")}
            className="bg-blue-50 text-blue-600 hover:bg-blue-100 px-4 py-2 rounded-lg text-sm font-bold transition-colors flex items-center gap-2"
          >
            ← Change Client
          </button>
          <button onClick={handleLogout} className="text-slate-500 hover:text-slate-800 text-sm font-medium px-2">
            Logout
          </button>
        </div>
      </div>

      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold text-slate-800 mb-2">EEG Session Setup</h1>
        <p className="text-slate-500">
          Pairing headset for patient: <span className="font-bold text-blue-600">{selectedClient.name}</span>
        </p>
      </div>

      <div className="bg-white w-full max-w-xl p-8 rounded-xl shadow-sm border border-slate-200 mb-6">
        <label className="block text-sm font-bold text-slate-700 mb-4 text-center">
          Bridge Pairing Code
        </label>
        
        {feedback.message && (
          <div className={`mb-4 p-3 rounded text-sm font-medium text-center ${feedback.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
            {feedback.type === 'success' ? '✅' : '⚠️'} {feedback.message}
          </div>
        )}

        <form onSubmit={handleVerify} className="text-center">
          <input 
            type="text" maxLength="6" placeholder="E.g. C2E2AA"
            disabled={isLoading || feedback.type === "success"}
            value={pairingCode} onChange={(e) => setPairingCode(e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase())}
            className="w-48 text-center text-3xl font-bold tracking-widest p-4 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-6 uppercase text-slate-800"
          />
          <button 
            type="submit" disabled={pairingCode.length !== 6 || isLoading}
            className={`w-full py-4 rounded-lg font-bold text-white transition-all shadow-sm ${pairingCode.length === 6 && !isLoading ? 'bg-blue-600 hover:bg-blue-700' : 'bg-slate-300 cursor-not-allowed'}`}
          >
            {isLoading ? "Verifying..." : "Verify Code & Continue"}
          </button>
        </form>
      </div>
    </main>
  );
}