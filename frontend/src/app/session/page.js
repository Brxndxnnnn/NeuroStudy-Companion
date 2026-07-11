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
      <div className="w-full max-w-4xl flex justify-between items-center mb-16 bg-white p-4 px-6 rounded-2xl shadow-sm border border-slate-200">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold shadow-sm">NS</div>
          <span className="font-extrabold text-slate-800 text-lg tracking-tight">NeuroStudy</span>
        </div>
        <div className="flex items-center gap-4">
          <button 
            onClick={() => router.push("/history")}
            className="text-slate-500 hover:text-blue-600 bg-slate-50 hover:bg-blue-50 px-4 py-2 rounded-lg text-sm font-bold transition-all flex items-center gap-2"
          >
            ← Change Client
          </button>
          <div className="h-6 w-px bg-slate-200"></div>
          <button onClick={handleLogout} className="text-slate-400 hover:text-red-600 text-sm font-bold px-2 transition-colors">
            Logout
          </button>
        </div>
      </div>

      <div className="text-center mb-10 animate-in fade-in slide-in-from-bottom-4">
        <h1 className="text-4xl font-extrabold text-slate-800 mb-3 tracking-tight">EEG Session Setup</h1>
        <p className="text-slate-500 text-lg">
          Pairing headset for patient: <span className="font-bold text-blue-600 bg-blue-50 px-3 py-1 rounded-lg ml-1">{selectedClient.name}</span>
        </p>
      </div>

      <div className="bg-white w-full max-w-lg p-10 rounded-3xl shadow-xl shadow-slate-200/50 border border-slate-100 animate-in fade-in zoom-in-95">
        <label className="block text-sm font-bold text-slate-500 uppercase tracking-widest mb-6 text-center">
          Bridge Pairing Code
        </label>
        
        {feedback.message && (
          <div className={`mb-6 p-4 rounded-xl text-sm font-bold text-center border ${feedback.type === 'success' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
            {feedback.type === 'success' ? '✅' : '⚠️'} {feedback.message}
          </div>
        )}

        <form onSubmit={handleVerify} className="flex flex-col items-center">
          <input 
            type="text" maxLength="6" placeholder="C2E2AA"
            disabled={isLoading || feedback.type === "success"}
            value={pairingCode} onChange={(e) => setPairingCode(e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase())}
            className="w-64 text-center text-4xl font-black tracking-[0.25em] p-5 rounded-2xl border-2 border-slate-200 focus:outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/20 mb-8 uppercase text-slate-800 transition-all placeholder:text-slate-200 placeholder:font-medium placeholder:tracking-normal disabled:bg-slate-50 disabled:text-slate-400"
          />
          <button 
            type="submit" disabled={pairingCode.length !== 6 || isLoading}
            className={`w-full py-4 rounded-xl font-bold text-white transition-all shadow-sm flex justify-center items-center gap-2 ${pairingCode.length === 6 && !isLoading ? 'bg-blue-600 hover:bg-blue-700 active:scale-[0.98] hover:shadow-md' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                Verifying...
              </span>
            ) : "Verify Code & Continue"}
          </button>
        </form>
      </div>
    </main>
  );
}