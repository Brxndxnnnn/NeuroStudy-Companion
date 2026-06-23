"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function SessionSetup() {
  const router = useRouter();
  const [pairingCode, setPairingCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [feedback, setFeedback] = useState({ type: "", message: "" });

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) router.push("/login");
  }, [router]);

  // STEP 1: CLAIM THE SESSION
  const handleVerify = async (e) => {
    e.preventDefault();
    setFeedback({ type: "", message: "" });
    if (pairingCode.length !== 6) return;
    setIsLoading(true);

    try {
      const rawToken = localStorage.getItem("token") || "";
      const cleanToken = rawToken.replace(/^["']|["']$/g, '').trim();
      
      const response = await fetch("http://139.59.126.77/api/sessions/pair", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cleanToken}` },
        body: JSON.stringify({ pairing_code: pairingCode, "client_id": "c0000000-0000-0000-0000-000000000001" }), // Only sending the code
      });

      if (response.ok) {
        const data = await response.json();
        console.log(data)
        // Save the ID for Steps 2 & 3
        localStorage.setItem("currentSessionId", data.session.session_id || data.id);
        
        setFeedback({ type: "success", message: "Paired successfully! Initializing..." });
        setTimeout(() => router.push("/session/active"), 1500);
      } else {
        setFeedback({ type: "error", message: "Invalid pairing code or session already claimed." });
      }
    } catch (error) {
      setFeedback({ type: "error", message: "Network error: Could not reach database." });
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("currentSessionId");
    router.push("/login");
  };
return (
    <main className="min-h-screen bg-slate-50 p-8 font-sans flex flex-col items-center">
      
      {/* NEW: Top Navigation Bar */}
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
            📊 Client History
          </button>
          <button 
            onClick={handleLogout} 
            className="text-slate-500 hover:text-slate-800 text-sm font-medium px-2"
          >
            Logout
          </button>
        </div>
      </div>

      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold text-slate-800 mb-2">EEG Session Setup</h1>
        <p className="text-slate-500">Link your desktop session to begin the recording sequence.</p>
      </div>

      <div className="bg-white w-full max-w-xl p-8 rounded-xl shadow-sm border border-slate-200 mb-6">
        <label className="block text-sm font-bold text-slate-700 mb-4 text-center">
          Bridge Pairing Code
        </label>
        
        {feedback.type === "error" && <div className="mb-4 p-3 bg-red-50 text-red-700 rounded text-sm font-medium text-center">⚠️ {feedback.message}</div>}
        {feedback.type === "success" && <div className="mb-4 p-3 bg-green-50 text-green-700 rounded text-sm font-medium text-center">✅ {feedback.message}</div>}

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